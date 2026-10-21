/**
 * Restores a full-instance backup zip.
 * Usage: pnpm restore-backup [--dry-run] <path-to-backup.zip>
 *
 * Deliberately a CLI, not an HTTP endpoint — restoring over a live
 * instance is not a button (spec 7's implementation plan). Validates the
 * archive, plans, applies, then prints the plan. Runs only on an empty
 * instance; no override. On an instance already restored from this
 * archive it writes nothing. `--dry-run` stops after the plan.
 * The output is counts and messages only: never a secret, hash or note.
 */
import { readFile } from 'node:fs/promises'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { runMigrations } from '../db/migrate.js'
import { sql } from '../db/client.js'
import {
  BackupInvalidError,
  RestoreRefusedError,
  restoreBackup,
  type RestorePlan,
} from '../export/restore.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const path = args.find((arg) => arg !== '--dry-run')
if (!path) {
  console.error('Usage: pnpm restore-backup [--dry-run] <path-to-backup.zip>')
  process.exit(1)
}

function printPlan(plan: RestorePlan): void {
  console.log(`Archive: format ${plan.format}, sha256 ${plan.archive}`)
  console.log('Rows (in archive / to restore / already here):')
  for (const t of plan.tables) console.log(`  ${t.table}: ${t.inArchive} / ${t.toRestore} / ${t.present}`)
  console.log('Files (in archive / to write / already here):')
  for (const f of plan.files) console.log(`  ${f.kind}: ${f.inArchive} / ${f.toWrite} / ${f.present}`)
  for (const warning of plan.warnings) console.log(`  warning: ${warning}`)
}

/**
 * The driver's message and code only. A drizzle error's message carries the
 * query parameters, and a Postgres error's detail the failing row: both can
 * hold password hashes and TOTP secrets. The code is taken from the first
 * error in the `cause` chain that has one (drizzle's `DrizzleQueryError` wraps
 * the driver error); a drizzle error without one gets a fixed message. Matched
 * by class: drizzle does not set the error's `name` (#813).
 */
function describeError(err: unknown): string {
  for (let current = err; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') return `${current.message} (${current.code})`
  }
  return err instanceof Error && !(err instanceof DrizzleQueryError) ? err.message : 'a database query failed'
}

await runMigrations()

let exitCode = 0
try {
  const plan = await restoreBackup(await readFile(path), { dryRun })
  if (plan.alreadyRestored) {
    console.log(`Archive: format ${plan.format}, sha256 ${plan.archive}`)
    console.log(`Already restored from this archive at ${plan.alreadyRestored}: nothing to do, nothing written.`)
  } else {
    printPlan(plan)
    console.log(
      dryRun
        ? 'Dry run: nothing written.'
        : 'Restore complete. Sessions are not restored: everyone signs in again. ' +
            'MCP tokens keep working (account, vault and repository tokens), except any a warning above lists as left out. ' +
            'Restart the server: it computes the embeddings when it starts, and repository indexes are rebuilt by the next sync.',
    )
  }
} catch (err) {
  if (err instanceof RestoreRefusedError) {
    printPlan(err.plan)
    console.error(err.message)
  } else if (err instanceof BackupInvalidError) {
    console.error(`Refusing to restore: ${err.message}`)
  } else {
    console.error(`Restore failed: ${describeError(err)}`)
  }
  exitCode = 1
}

await sql.end()
process.exit(exitCode)
