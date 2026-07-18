import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes } from '../db/schema.js'
import { embedder } from './embeddings.js'
import { recomputeSemanticEdges } from './semantic-edges.js'

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
  await recomputeSemanticEdges('note', noteId, embedding!)
}
