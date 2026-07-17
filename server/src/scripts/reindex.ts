/**
 * Full derived-index rebuild from the DB note index: wikilink rows and
 * embeddings for every live note. Run manually (`pnpm reindex`) after
 * changing the embedder or restoring files out-of-band.
 */
import { isNull } from 'drizzle-orm'
import { db, sql } from '../db/client.js'
import { notes } from '../db/schema.js'
import { runMigrations } from '../db/migrate.js'
import { syncNoteLinks } from '../notes/store.js'
import { flushEmbeddings, scheduleEmbedding } from '../search/embedding-queue.js'

await runMigrations()
const rows = await db
  .select({ id: notes.id, body: notes.body })
  .from(notes)
  .where(isNull(notes.deletedAt))
console.log(`reindexing ${rows.length} notes...`)
for (const row of rows) {
  await syncNoteLinks(row.id, row.body)
  scheduleEmbedding(row.id)
}
await flushEmbeddings()
console.log('done')
await sql.end()
