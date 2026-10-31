// Semantic-edge writers in flight (ADR-004 §1.3, #1007). #1026: a recompute or a merge that read a node before a
// delete committed must not write a row naming it afterwards, or the node that holds it keeps a row to a node in the
// trash and is never queued. #1027: a list recomputed while an embed's refresh reads the lists must end as the
// content's top-k. Each case orders two sessions with a lock that a third session holds and releases (a row lock on
// one of the list's rows pauses a recompute at its write; a list's advisory lock pauses a merge before it reads the
// list), found through `pg_blocking_pids`, so the interleaving is the same on every run. The worlds and rows are
// those of `semantic-edges-deletes.test.ts`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { createNote, softDeleteNote } from '../src/notes/store.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { recomputeSemanticEdges, refreshSemanticEdges, type SemanticNodeType } from '../src/search/semantic-edges.js'
import { K, NOTES, VICTIM_FILE, VICTIM_NOTE, cleanup, fileId, noteId, rowsTouching, settle, storedRows, world } from './semantic-edges-world.js'

let full: string[]
let withoutNote: string[]

beforeAll(async () => {
  const w = await world()
  full = await storedRows([w.vaultId, w.repositoryId])
  const b = await world([VICTIM_NOTE])
  withoutNote = await storedRows([b.vaultId, b.repositoryId])
}, 120_000)

afterAll(async () => {
  await cleanup()
})

/**
 * Runs `lock` in a transaction of its own and keeps it open: its backend's pid, and `release`, which runs `before`
 * in that transaction (a write another session should find) and commits.
 */
async function hold(lock: SQL): Promise<{ pid: number; release: (before?: SQL) => Promise<void> }> {
  // `Promise.withResolvers` is ES2024, past the server's `lib`.
  let close!: (before: SQL | undefined) => void
  const closing = new Promise<SQL | undefined>((resolve) => (close = resolve))
  let started!: (pid: number) => void
  const ready = new Promise<number>((resolve) => (started = resolve))
  const done = db.transaction(async (tx) => {
    const [row] = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as Array<{ pid: number }>
    await tx.execute(lock)
    started(row!.pid)
    const before = await closing
    if (before) await tx.execute(before)
  })
  const pid = await Promise.race([ready, done.then(() => -1)])
  return {
    pid,
    release: async (before?: SQL) => {
      close(before)
      await done
    },
  }
}

/** The backends waiting for a lock that backend `pid` holds. */
async function waitingFor(pid: number): Promise<number[]> {
  const rows = (await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`)) as unknown as Array<{ pid: number }>
  return rows.map((r) => r.pid)
}

/**
 * Waits until a backend waits for backend `pid` (or `settled` is true); returns that backend, or null. Polled: the
 * wait is another session's state in Postgres, which signals nothing to this process.
 */
async function blockedBy(pid: number, settled: () => boolean = () => false): Promise<number | null> {
  for (let i = 0; i < 1500; i++) {
    const [waiting] = await waitingFor(pid)
    if (waiting !== undefined) return waiting
    if (settled()) return null
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`nothing waited for backend ${pid}`)
}

/** `promise`, with whether it has settled. */
function tracked<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true),
  )
  return { promise, settled: () => done }
}

async function embedKeys(type: SemanticNodeType, id: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT embed_key FROM blocks WHERE owner_type = ${type} AND owner_id = ${id} AND embedding IS NOT NULL ORDER BY embed_key`)) as unknown as Array<{
    embed_key: string
  }>
  return rows.map((r) => r.embed_key)
}

/** A row of list `listId` other than the one naming `exceptId`: its first by similarity. */
async function otherRow(listId: string, exceptId: string): Promise<string> {
  const [row] = (await db.execute(sql`
    SELECT node_b_id AS id FROM semantic_edges WHERE node_a_id = ${listId} AND node_b_id <> ${exceptId}
    ORDER BY similarity DESC, node_b_id LIMIT 1`)) as unknown as Array<{ id: string }>
  return row!.id
}

/** Locks list `listId`'s row naming `targetId` (FOR UPDATE): a recompute of the list waits at its write. */
const rowLock = (listId: string, targetId: string) => sql`SELECT 1 FROM semantic_edges WHERE node_a_id = ${listId} AND node_b_id = ${targetId} FOR UPDATE`

/** The advisory lock of list `type:id` (`recomputeSemanticEdges`, `mergeEntered`): a merge into it waits for it. */
const listLock = (type: SemanticNodeType, id: string) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${`semantic_edges:${type}:${id}`}, 0))`

describe('a writer in flight while a node it read is deleted (#1026)', () => {
  it('a recompute that read the node before its trash committed: no row names it, and the holder gets its next neighbour', async () => {
    const w = await world()
    const hub = await noteId(w.vaultId, 'notes/hub')
    const victim = await noteId(w.vaultId, VICTIM_NOTE)
    // The hub's list before the victim entered it: when the trash reads the victim's holders, the hub is not one.
    await db.execute(sql`DELETE FROM semantic_edges WHERE node_a_id = ${hub} AND node_b_id = ${victim}`)
    const blocker = await hold(rowLock(hub, await otherRow(hub, victim)))
    // 1. The hub's recompute finds the victim among its K, then waits at its write.
    const recompute = tracked(recomputeSemanticEdges('note', hub))
    const writer = await blockedBy(blocker.pid)
    expect(writer).not.toBeNull()
    // 2. The victim is trashed: on the base it commits here; a fix may make it wait for the recompute.
    const trash = tracked(softDeleteNote(w.vaultId, VICTIM_NOTE))
    await blockedBy(writer!, trash.settled)
    // 3. The recompute writes its rows.
    await blocker.release()
    await recompute.promise
    expect(await trash.promise).not.toBeNull()
    await settle()
    expect(await rowsTouching([victim])).toBe(0)
    expect(await storedRows([w.vaultId, w.repositoryId])).toEqual(withoutNote)
  }, 120_000)

  it('a merge of a new note into a list it entered, with the note trashed meanwhile: no row names it', async () => {
    const w = await world([VICTIM_NOTE])
    expect(await storedRows([w.vaultId, w.repositoryId])).toEqual(withoutNote)
    // A file that holds the victim in the full world: the victim's embed enters its list.
    const holder = full.find((r) => r.startsWith('code:') && r.includes(`→ note:deletes-vault/${VICTIM_NOTE} `))!
    const list = await fileId(w.repositoryId, holder.slice('code:deletes-repo/'.length, holder.indexOf(' →')))
    const blocker = await hold(listLock('code', list))
    // 1. The victim is created; its embed's refresh finds the lists it enters and waits for that one's lock.
    await createNote(w.vaultId, NOTES.find((n) => n.path === VICTIM_NOTE)!)
    const embedding = tracked(flushEmbeddings())
    expect(await blockedBy(blocker.pid, embedding.settled)).not.toBeNull()
    // 2. The victim is trashed, and that commits.
    expect(await softDeleteNote(w.vaultId, VICTIM_NOTE)).not.toBeNull()
    // 3. The merge goes on.
    await blocker.release()
    await embedding.promise
    await settle()
    expect(await rowsTouching([await noteId(w.vaultId, VICTIM_NOTE)])).toBe(0)
    expect(await storedRows([w.vaultId, w.repositoryId])).toEqual(withoutNote)
  }, 120_000)
})

describe("a list written while an embed's refresh reads the lists (#1027)", () => {
  /** A note whose K rows name the victim file, not as the last: its list, the file, and another row of it. */
  async function noteHoldingFile(w: { vaultId: string; repositoryId: string }) {
    const file = await fileId(w.repositoryId, VICTIM_FILE)
    const [row] = (await db.execute(sql`
      SELECT e.node_a_id AS id FROM semantic_edges e JOIN notes n ON n.id = e.node_a_id
      WHERE n.vault_id = ${w.vaultId} AND e.node_a_type = 'note' AND e.node_b_type = 'code' AND e.node_b_id = ${file}
        AND (SELECT count(*) FROM semantic_edges s WHERE s.node_a_type = 'note' AND s.node_a_id = e.node_a_id) = ${K}
        AND e.similarity > (SELECT min(s.similarity) FROM semantic_edges s WHERE s.node_a_type = 'note' AND s.node_a_id = e.node_a_id)
      ORDER BY n.path LIMIT 1`)) as unknown as Array<{ id: string }>
    expect(row).toBeDefined()
    // Its list as before the file entered it: when the file's refresh reads its holders, the note is not one.
    await db.execute(sql`DELETE FROM semantic_edges WHERE node_a_id = ${row!.id} AND node_b_id = ${file}`)
    return { list: row!.id, file }
  }

  it("a recompute that read the file's vectors commits after the file's refresh read its holders: the content's top-k", async () => {
    const w = await world()
    const { list, file } = await noteHoldingFile(w)
    const blocker = await hold(rowLock(list, await otherRow(list, file)))
    // 1. The note's recompute finds the file among its K, then waits at its write.
    const recompute = tracked(recomputeSemanticEdges('note', list))
    const writer = await blockedBy(blocker.pid)
    expect(writer).not.toBeNull()
    // 2. The file's refresh (its embed committed new vectors) waits for the note's list.
    const refresh = tracked(refreshSemanticEdges('code', file, await embedKeys('code', file)))
    expect(await blockedBy(writer!, refresh.settled)).not.toBeNull()
    // 3. The recompute writes the note's list, the file in it; the refresh goes on.
    await blocker.release()
    await recompute.promise
    await refresh.promise
    await settle()
    expect(await storedRows([w.vaultId, w.repositoryId])).toEqual(full)
  }, 120_000)

  it("a list that holds the file by the time the file's merge locks it: the content's top-k", async () => {
    const w = await world()
    const { list, file } = await noteHoldingFile(w)
    // A session holds the note's list lock, as a recompute of the note does.
    const blocker = await hold(listLock('note', list))
    // 1. The file's refresh reads its holders (not the note), finds the note among the lists it enters, and waits.
    const refresh = tracked(refreshSemanticEdges('code', file, await embedKeys('code', file)))
    expect(await blockedBy(blocker.pid, refresh.settled)).not.toBeNull()
    // 2. That session writes the note's row naming the file, as the recompute that read the file's vectors does.
    await blocker.release(sql`
      INSERT INTO semantic_edges (node_a_type, node_a_id, node_b_type, node_b_id, similarity)
      SELECT 'note', ${list}::uuid, 'code', ${file}::uuid, 1 - min(b.embedding <=> q.embedding)
      FROM blocks b CROSS JOIN LATERAL (
        SELECT embedding FROM blocks WHERE owner_type = 'note' AND owner_id = ${list} AND embedding IS NOT NULL
        ORDER BY start_line, block_id LIMIT 16) q
      WHERE b.owner_type = 'code' AND b.owner_id = ${file} AND b.embedding IS NOT NULL`)
    await refresh.promise
    await settle()
    expect(await storedRows([w.vaultId, w.repositoryId])).toEqual(full)
  }, 120_000)
})
