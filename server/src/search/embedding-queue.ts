import { and, eq, isNull, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, semanticEdges } from '../db/schema.js'
import { config } from '../config.js'
import { embedder } from './embeddings.js'

// ponytail: in-process serial queue; move to a job table if multi-process
const queue: string[] = []
let running: Promise<void> | null = null

/** Enqueue a note for (re-)embedding. Never blocks the caller (perf rule 2). */
export function scheduleEmbedding(noteId: string): void {
  queue.push(noteId)
  running ??= drain().finally(() => {
    running = null
  })
}

/** Awaits until the queue is empty — tests and batch jobs only. */
export async function flushEmbeddings(): Promise<void> {
  while (running) await running
}

/** Boot catch-up: enqueue live notes that never got an embedding. */
export async function scheduleMissingEmbeddings(): Promise<number> {
  const missing = await db
    .select({ id: notes.id })
    .from(notes)
    .where(and(isNull(notes.deletedAt), sql`${notes.embedding} is null`))
  for (const row of missing) scheduleEmbedding(row.id)
  return missing.length
}

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const noteId = queue.shift()!
    try {
      await processNote(noteId)
    } catch (err) {
      console.error(`embedding failed for note ${noteId}:`, err)
    }
  }
}

async function processNote(noteId: string): Promise<void> {
  const row = (await db.select().from(notes).where(eq(notes.id, noteId)))[0]
  if (!row || row.deletedAt) return
  const text = `${row.path}\n${JSON.stringify(row.frontmatter)}\n${row.body}`
  const [embedding] = await embedder.embed([text])
  await db.update(notes).set({ embedding }).where(eq(notes.id, noteId))

  // Recompute this note's semantic edges: one KNN, ordered-pair upserts.
  await db
    .delete(semanticEdges)
    .where(or(eq(semanticEdges.noteA, noteId), eq(semanticEdges.noteB, noteId)))
  const vec = JSON.stringify(embedding)
  const neighbors = await db
    .select({
      id: notes.id,
      similarity: sql<number>`1 - (${notes.embedding} <=> ${vec}::vector)`,
    })
    .from(notes)
    .where(and(ne(notes.id, noteId), isNull(notes.deletedAt), sql`${notes.embedding} is not null`))
    .orderBy(sql`${notes.embedding} <=> ${vec}::vector`)
    .limit(config.semanticK)
  const strong = neighbors.filter((n) => n.similarity >= config.semanticThreshold)
  if (strong.length > 0) {
    await db
      .insert(semanticEdges)
      .values(
        strong.map((n) => ({
          noteA: noteId < n.id ? noteId : n.id,
          noteB: noteId < n.id ? n.id : noteId,
          similarity: n.similarity,
        })),
      )
      .onConflictDoUpdate({
        target: [semanticEdges.noteA, semanticEdges.noteB],
        set: { similarity: sql`excluded.similarity` },
      })
  }
}
