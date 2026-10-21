/**
 * Last-resort import (ADR-003 Q9, #495): rebuilds missing note rows from the
 * `.md` files (notes/rows-from-files.ts). Revisions and CRDT history are not
 * recovered; a pg_dump restore is the real recovery (backup.md). Usage:
 *   pnpm rows-from-files [-- --dry-run] [--vault <uuid>] [--owner <email>]
 * Run with the server stopped: it takes the exclusive instance maintenance
 * lock and refuses (exit 2) while a server or writing CLI holds the shared
 * form. `--dry-run` reads only and takes no lock. Prints the JSON report;
 * exits 1 when a file failed or a row differs from its file, 2 on bad
 * arguments or while the instance is in use.
 */
import { sql } from '../db/client.js'
import { MaintenanceInProgressError } from '../notes/maintenance-lock.js'
import { UnknownOwnerError, rowsFromFiles } from '../notes/rows-from-files.js'

const USAGE = 'usage: rows-from-files [--dry-run] [--vault <vault-id>] [--owner <email>]'
const args = process.argv.slice(2).filter((arg) => arg !== '--')
let dryRun = false
let vaultId: string | undefined
let ownerEmail: string | undefined
let bad = false
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  const value = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined
  if (arg === '--dry-run') dryRun = true
  else if (arg === '--vault' && value) vaultId = args[++i]
  else if (arg === '--owner' && value) ownerEmail = args[++i]
  else bad = true
}
if (bad) {
  console.error(USAGE)
  await sql.end()
  process.exit(2)
}

let exitCode = 0
try {
  const report = await rowsFromFiles({ dryRun, vaultId, ownerEmail })
  await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => resolve()))
  console.error(
    `rows-from-files${dryRun ? ' (dry run)' : ''}: ${report.created.length} ${dryRun ? 'to create' : 'created'}, ` +
      `${report.unchanged} unchanged, ${report.differs.length} differ (left alone), ${report.skipped.length} skipped, ` +
      `${report.failed.length} failed; vaults ${dryRun ? 'to create' : 'created'} ${report.vaultsCreated.length}, skipped ${report.vaultsSkipped.length}`,
  )
  if (report.failed.length > 0 || report.differs.length > 0) exitCode = 1
} catch (err) {
  const refused = err instanceof MaintenanceInProgressError || err instanceof UnknownOwnerError
  console.error(refused ? err.message : err)
  exitCode = refused ? 2 : 1
}
await sql.end()
process.exit(exitCode)
