/**
 * The stopped-server export for a code-only rollback (ADR-003 §9, Q10),
 * S2a form: files only. Run with no server up
 * (`docker compose run --rm app pnpm store-export-legacy`).
 *
 * It takes the instance maintenance lock in its exclusive form on a reserved
 * connection (maintenance-lock.ts), so it refuses to run while any server or
 * writing CLI holds the shared form, and a server started meanwhile refuses
 * to start. Then it fills missing store state (boot step 3: rows written
 * around the store get projection rows and raised targets) and renders every
 * pending `file` and `dir_index` projection and every store job (rename
 * refactors, file removals, old-folder indexes) synchronously under the
 * ownership rules, so every `.md` file and `index.md` matches the rows before
 * the old image starts. `.crdt/` needs nothing in S2a: the S2a relay kept the
 * bins current by path.
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
import { STORE_JOBS, conflictCopies, flushProjections } from './projector.js'
import { reconcileStore } from './store-reconcile.js'

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
    const reconciled = await reconcileStore()
    // Failed projections back off; the export retries them now.
    await db.execute(sql`
      UPDATE note_projections SET lease_until = NULL, attempts = 0
      WHERE applied_seq < target_seq AND projection IN ('file', 'dir_index')`)
    await db.execute(sql`UPDATE jobs SET lease_until = NULL WHERE done_at IS NULL AND kind IN ${Object.values(STORE_JOBS)}`)
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
