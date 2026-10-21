/**
 * The stopped-server export for a code-only rollback (ADR-003 §9, Q10),
 * S2a form: files only. Run with no server up
 * (`docker compose run --rm app pnpm store-export-legacy`).
 *
 * It takes the instance maintenance lock in its exclusive form on a reserved
 * connection (maintenance-lock.ts), so it refuses to run while any server or
 * writing CLI holds the shared form, and a server started meanwhile refuses
 * to start. Then it fills missing store state (boot step 3: rows written
 * around the store get projection rows and raised targets), marks every
 * `file` and `dir_index` projection for verification against the disk (the
 * export runs offline, and after an unclean stop a file whose projection is
 * marked applied can be truncated; the old image reads files over rows),
 * and renders every projection and every store job (rename refactors, file
 * removals, old-folder indexes) synchronously under the ownership rules, so
 * every `.md` file and `index.md` matches the rows before the old image
 * starts. Store jobs that are leased, out of attempts or failed for good are
 * run again: their work must be done before the old image starts. `.crdt/`
 * needs nothing in S2a: the S2a relay kept the bins current by path.
 *
 * It refuses to run while the S2a backfill has not finished
 * (`store_migrated_at` unset): the notes it could not process have no
 * `backfill` marker and their files must still win (Q5), so rendering rows
 * over them would lose that. The old image needs nothing then: S2a has not
 * written those notes. Only `file` and `dir_index` projections are rendered;
 * the `backfill` marker rows are not projections and are left alone.
 *
 * Writes `DATA_DIR/store-export-legacy-<utc>.json` and returns the report;
 * `ok` is false when a projection or store job is still pending (its last
 * error is listed), and the rollback must not go ahead then.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { holdInstanceLock } from './maintenance-lock.js'
import { STORE_JOBS, conflictCopies, flushProjections, verifyAllProjections } from './projector.js'
import { reconcileStore, storeMigrated } from './store-reconcile.js'
// Registers the rename refactor runner the projector calls for `store_rename_refactor` jobs.
import './store.js'

/** The S2a backfill has failures: the export would overwrite files that must win. */
export class BackfillPendingError extends Error {
  constructor() {
    super('the S2a store backfill has not finished (see the migration report): start the new image until it does, or restore the pre-upgrade backup')
  }
}

export interface LegacyExportReport {
  kind: 'adr-003-store-export-legacy'
  startedAt: string
  finishedAt: string
  ok: boolean
  reconciled: { projections: number; raised: number; revisions: number; failed: number }
  /** Projections still behind their target after the drain, with their last error. */
  pending: Array<{ noteId: string; projection: string; lastError: string | null }>
  /** Store jobs not done after the drain. */
  pendingJobs: Array<{ id: number; kind: string; lastError: string | null }>
  /** Files that held bytes the projector did not write, copied to `.conflicts/` first. */
  conflictCopies: Array<{ vaultId: string; path: string; copy: string }>
  reportFile: string
}

export async function exportLegacyFiles(): Promise<LegacyExportReport> {
  let lost = false
  const lock = await holdInstanceLock('exclusive', { onLost: () => (lost = true) })
  const startedAt = new Date().toISOString()
  const conflictsBefore = conflictCopies.length
  try {
    if (!(await storeMigrated())) throw new BackfillPendingError()
    const reconciled = await reconcileStore()
    await verifyAllProjections()
    // Failed projections back off; the export retries them now.
    await db.execute(sql`
      UPDATE note_projections SET lease_until = NULL, attempts = 0
      WHERE applied_seq < target_seq AND projection IN ('file', 'dir_index')`)
    // Store jobs: leased, out of attempts, or given up (done with an error) run again now.
    await db.execute(sql`
      UPDATE jobs SET lease_until = NULL, attempts = 0, done_at = NULL
      WHERE kind IN ${Object.values(STORE_JOBS)} AND (done_at IS NULL OR last_error IS NOT NULL)`)
    await flushProjections()
    const pending = (await db.execute(sql`
      SELECT note_id, projection, last_error FROM note_projections
      WHERE applied_seq < target_seq AND projection IN ('file', 'dir_index') ORDER BY note_id`)) as unknown as Array<{
      note_id: string
      projection: string
      last_error: string | null
    }>
    const jobs = (await db.execute(sql`
      SELECT id, kind, last_error FROM jobs WHERE done_at IS NULL AND kind IN ${Object.values(STORE_JOBS)} ORDER BY id`)) as unknown as Array<{
      id: string | number
      kind: string
      last_error: string | null
    }>
    if (lost) throw new Error('the exclusive instance lock was lost during the export: run it again')
    const finishedAt = new Date().toISOString()
    const reportFile = join(config.dataDir, `store-export-legacy-${finishedAt.replace(/[:.]/g, '-')}.json`)
    const report: LegacyExportReport = {
      kind: 'adr-003-store-export-legacy',
      startedAt,
      finishedAt,
      ok: pending.length === 0 && jobs.length === 0,
      reconciled,
      pending: pending.map((p) => ({ noteId: p.note_id, projection: p.projection, lastError: p.last_error })),
      pendingJobs: jobs.map((j) => ({ id: Number(j.id), kind: j.kind, lastError: j.last_error })),
      conflictCopies: conflictCopies.slice(conflictsBefore),
      reportFile,
    }
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    await lock.release()
  }
}
