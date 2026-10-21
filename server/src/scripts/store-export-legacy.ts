/**
 * ADR-003 §9 code-only rollback, step 2: run with the server stopped
 * (`docker compose run --rm app pnpm store-export-legacy`).
 * Takes the exclusive instance lock (refused while a server or writing CLI
 * runs), folds every collab tail, renders every pending file and index.md
 * from the rows, writes each live note's `.crdt` bin for the old relay,
 * writes a report to DATA_DIR and exits 0 only when nothing is left pending.
 * See notes/store-export.ts and docs/self-hosting/backup.md §5.
 */
import { sql } from '../db/client.js'
import { MaintenanceInProgressError } from '../notes/maintenance-lock.js'
import { exportLegacyFiles } from '../notes/store-export.js'

let exitCode = 0
try {
  const report = await exportLegacyFiles()
  console.log(
    `store-export-legacy: ${report.ok ? 'done' : 'INCOMPLETE'}; ${report.pending.length} projection(s) and ` +
      `${report.pendingJobs.length} store job(s) pending, ${report.conflictCopies.length} conflict copy(ies); ` +
      `${report.bins.written} .crdt bin(s) written, ${report.bins.skipped.length} skipped, ${report.bins.failed.length} failed; ` +
      `${report.folded.failed} collab fold(s) failed; report ${report.reportFile}`,
  )
  if (!report.ok) {
    console.error('Do not start the old image: fix the errors in the report and run store-export-legacy again.')
    exitCode = 1
  }
} catch (err) {
  console.error(err instanceof MaintenanceInProgressError ? err.message : err)
  exitCode = err instanceof MaintenanceInProgressError ? 2 : 1
}
await sql.end()
process.exit(exitCode)
