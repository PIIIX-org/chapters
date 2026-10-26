/**
 * Full derived-index rebuild from the DB note index: wikilink rows and
 * embeddings for every live note, then the semantic edges of every note and
 * repository file. Run manually (`pnpm reindex`) after restoring files
 * out-of-band. A changed embedder or embed text needs no reindex: bump
 * `EMBEDDER_ID` (search/embeddings.ts) and the next boot re-embeds every note
 * and file (#453).
 */
import { isNull } from 'drizzle-orm'
import { db, sql } from '../db/client.js'
import { notes } from '../db/schema.js'
import { runMigrations } from '../db/migrate.js'
import { syncNoteLinks } from '../notes/store.js'
import { JOB_PRIORITY } from '../jobs/durable.js'
import { enqueueEmbeddings, flushEmbeddings } from '../search/embedding-queue.js'
import { enqueueSemanticEdgeRebuild, runSemanticEdgeRebuild } from '../search/semantic-edges.js'
import { holdSharedLockOrExit } from '../notes/maintenance-lock.js'

// A writing CLI holds the shared instance lock (ADR-003 §5.1): refused while store-export-legacy runs.
const instanceLock = await holdSharedLockOrExit()
await runMigrations()
const rows = await db
  .select({ id: notes.id, body: notes.body })
  .from(notes)
  .where(isNull(notes.deletedAt))
console.log(`reindexing ${rows.length} notes...`)
for (const row of rows) {
  await syncNoteLinks(row.id, row.body)
}
// Re-embeds notes whose job for the current version already finished, too,
// behind the jobs of the running server's writes.
await enqueueEmbeddings(
  rows.map((r) => r.id),
  'finished',
  JOB_PRIORITY.catchUp,
)
await flushEmbeddings()
// A re-embed that keeps every vector leaves the edges as they were: each node's
// own top-k is recomputed from the stored vectors (#1007).
console.log(`recomputing the semantic edges of ${await enqueueSemanticEdgeRebuild('finished')} notes and files...`)
await runSemanticEdgeRebuild()
console.log('done')
await instanceLock.release()
await sql.end()
