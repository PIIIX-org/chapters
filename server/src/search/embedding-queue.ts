import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes } from '../db/schema.js'
import { embedder } from './embeddings.js'
import { recomputeSemanticEdges } from './semantic-edges.js'

interface QueueEntry {
  noteId: string
  attempts: number
}

// ponytail: in-process serial queue; move to a job table if multi-process
const queue: QueueEntry[] = []
let running: Promise<void> | null = null
const MAX_ATTEMPTS = 3

/** Enqueue a note for (re-)embedding. Never blocks the caller (perf rule 2). */
export function scheduleEmbedding(noteId: string, attempts = 0): void {
  queue.push({ noteId, attempts })
  running ??= drain().finally(() => {
    running = null
  })
}

/** Awaits until the queue is empty — tests and batch jobs only. */
export async function flushEmbeddings(): Promise<void> {
  while (running) await running
}

/** Boot catch-up: enqueue live notes that never got an embedding. */
export async function scheduleMissingEmbeddings(limit?: number): Promise<number> {
  const query = db
    .select({ id: notes.id })
    .from(notes)
    .where(and(isNull(notes.deletedAt), sql`${notes.embedding} is null`))
  const missing = limit ? await query.limit(limit) : await query
  for (const row of missing) scheduleEmbedding(row.id)
  return missing.length
}

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift()!
    try {
      await processNote(item.noteId)
    } catch (err) {
      const nextAttempt = item.attempts + 1
      if (nextAttempt < MAX_ATTEMPTS) {
        console.warn(
          `[embedding-queue] embedding failed for note ${item.noteId} (attempt ${nextAttempt}/${MAX_ATTEMPTS}), retrying:`,
          err,
        )
        queue.push({ noteId: item.noteId, attempts: nextAttempt })
      } else {
        console.error(
          `[embedding-queue] embedding permanently failed for note ${item.noteId} after ${MAX_ATTEMPTS} attempts:`,
          err,
        )
      }
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
