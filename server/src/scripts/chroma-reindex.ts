/**
 * Full Chroma vector index rebuild from PostgreSQL database:
 * Embeds and syncs all live notes, repository files, and AST symbols into Chroma collections.
 * Run manually (`pnpm chroma:reindex`) after switching to Chroma or wiping the Chroma volume.
 */
import { isNull } from 'drizzle-orm'
import { db, sql } from '../db/client.js'
import { notes, repositoryFiles } from '../db/schema.js'
import { runMigrations } from '../db/migrate.js'
import { syncNoteLinks } from '../notes/store.js'
import { flushEmbeddings, scheduleEmbedding } from '../search/embedding-queue.js'
import { scheduleExtraction } from '../repositories/extraction-queue.js'
import { vectorStore } from '../search/vector/index.js'

console.log('[chroma:reindex] running database migrations...')
await runMigrations()

console.log('[chroma:reindex] initializing vector store...')
await vectorStore.init()

const liveNotes = await db
  .select({ id: notes.id, body: notes.body })
  .from(notes)
  .where(isNull(notes.deletedAt))

console.log(`[chroma:reindex] reindexing ${liveNotes.length} notes into Chroma...`)
for (const note of liveNotes) {
  await syncNoteLinks(note.id, note.body)
  scheduleEmbedding(note.id)
}
await flushEmbeddings()

const repoFiles = await db
  .select({ id: repositoryFiles.id })
  .from(repositoryFiles)

console.log(`[chroma:reindex] reindexing ${repoFiles.length} repository files into Chroma...`)
for (const file of repoFiles) {
  scheduleExtraction(file.id)
}

console.log('[chroma:reindex] synchronization completed successfully.')
await sql.end()
