// #463: a note's vector is current after a restart, not only present. The
// write inserts the note's `embed_note` job for its new `seq` in its own
// transaction (#494); a process that dies while the job is running leaves it
// claimed (`attempts` counted, lease set, not done), and the job runs again
// once the lease has run out. Until then the note keeps the blocks of its
// previous seq (searchable, stale) and counts as pending.
//
// The kill is real at the job level: `claimJob` claims the row in the
// database, then the run is abandoned before anything else happens (no
// `failJob`, no write), which is what a dead process leaves. A death during
// the embed leaves the same row: the block set is written only at the end.
// After `MAX_JOB_ATTEMPTS` such runs the job is `LeaseExpired` and the boot
// does not re-run it (#453/#978: a job that took the process down 3 times
// would crash-loop the instance); the doctor reports it and its repair
// embeds the current text.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { blocks, jobs, vaults } from '../src/db/schema.js'
import type * as Durable from '../src/jobs/durable.js'
import { MAX_JOB_ATTEMPTS, type ClaimedJob } from '../src/jobs/durable.js'
import { runDoctor } from '../src/notes/doctor.js'
import { noteBlocks } from '../src/notes/note-blocks.js'
import { createNote, updateNote, type WrittenNote } from '../src/notes/store.js'
import { flushExtraction, scheduleMissingExtractions } from '../src/repositories/extraction-queue.js'
import { embedKey } from '../src/search/embed-key.js'
import {
  embeddingJobKey,
  embeddingState,
  flushEmbeddings,
  kickEmbeddings,
  scheduleMissingEmbeddings,
} from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser } from './helpers.js'

/** The note whose job runs end with the process, and how many more runs do. */
const kill = vi.hoisted(() => ({ noteId: '', runs: 0 }))

vi.mock('../src/jobs/durable.js', async (importOriginal) => {
  const real = await importOriginal<typeof Durable>()
  return {
    ...real,
    claimJob: async <P,>(kind: string, filter?: SQL): Promise<ClaimedJob<P> | null> => {
      const job = await real.claimJob<P>(kind, filter)
      const payload: unknown = job?.payload
      if (kill.runs > 0 && payload && typeof payload === 'object' && 'noteId' in payload && payload.noteId === kill.noteId) {
        kill.runs--
        throw new Error('the process died holding the lease (test)')
      }
      return job
    },
  }
})

const createdVaultIds: string[] = []
// Other test files leave stale notes in the shared database: drain them first, so the only jobs left are this file's.
beforeAll(async () => {
  await scheduleMissingEmbeddings()
  await scheduleMissingExtractions()
  await flushEmbeddings()
  await flushExtraction()
}, 600_000)
afterEach(async () => {
  kill.runs = 0
  vi.restoreAllMocks()
  for (const id of createdVaultIds.splice(0)) await db.delete(vaults).where(eq(vaults.id, id))
})

const V1 = '# Herons\nFirst text about herons at the lake.\n'
const V2 = '# Herons\nSecond text about egrets on the river.\n'

/** A note embedded at V1. */
async function embeddedNote() {
  const user = await createActiveUser()
  const [vault] = await db.insert(vaults).values({ name: 'embed-restart', ownerId: user.id }).returning()
  createdVaultIds.push(vault!.id)
  const note = await createNote(vault!.id, { path: `concepts/restart-${Math.random().toString(36).slice(2)}`, body: V1 })
  await flushEmbeddings()
  expect(await blockState(note.id)).toEqual({ seqs: [String(note.seq)], keys: keysOf(note, V1) })
  return { vaultId: vault!.id, note }
}

/** A note embedded at V1, then edited to V2 by a process that dies during the V2 embed job, `deaths` times in a row. */
async function editedThenKilled(deaths: number) {
  const { vaultId, note } = await embeddedNote()

  vi.spyOn(console, 'error').mockImplementation(() => {})
  kill.noteId = note.id
  kill.runs = deaths
  const edited = (await updateNote(vaultId, note.path, { body: V2 }))!
  await flushEmbeddings()
  const key = embeddingJobKey(note.id, edited.seq)
  return { vaultId, note, edited, key }
}

/** The embed keys V1/V2 give the note's blocks, sorted. */
function keysOf(note: WrittenNote, body: string): string[] {
  return noteBlocks(note.id, note.path, body)
    .map((b) => embedKey(b.embedText))
    .sort()
}

/** The seqs the note's blocks were derived from and their embed keys, sorted. */
async function blockState(noteId: string) {
  const rows = await db
    .select({ ownerVersion: blocks.ownerVersion, embedKey: blocks.embedKey })
    .from(blocks)
    .where(and(eq(blocks.ownerType, 'note'), eq(blocks.ownerId, noteId)))
  return { seqs: [...new Set(rows.map((r) => r.ownerVersion))], keys: rows.map((r) => r.embedKey).sort() }
}

async function jobByKey(key: string) {
  return (await db.select().from(jobs).where(eq(jobs.idempotencyKey, key)))[0]
}

/** The process is down longer than the lease, then boots: the catch-up scan, then the worker. */
async function reboot(key: string): Promise<void> {
  await db.update(jobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(jobs.idempotencyKey, key))
  await scheduleMissingEmbeddings()
  await flushEmbeddings()
}

/** The note's vectors are those of V2's texts: the blocks of the edit's seq, and each vector the embedding of its text. */
async function expectCurrent(note: WrittenNote, seq: number): Promise<void> {
  expect(await blockState(note.id)).toEqual({ seqs: [String(seq)], keys: keysOf(note, V2) })
  const texts = noteBlocks(note.id, note.path, V2).map((b) => b.embedText)
  const expected = await embedder.embed(texts)
  const rows = await db
    .select({ embedding: blocks.embedding })
    .from(blocks)
    .where(and(eq(blocks.ownerType, 'note'), eq(blocks.ownerId, note.id)))
    .orderBy(blocks.startLine, blocks.innerPath)
  expect(rows).toHaveLength(expected.length)
  rows.forEach((r, i) => expect(Math.max(...r.embedding!.map((v, j) => Math.abs(v - expected[i]![j]!)))).toBeLessThan(1e-6))
}

describe('a note edited just before the process died is embedded at its current text after the restart (#463)', () => {
  it('killed once while its embed job ran: the next boot embeds the edit', async () => {
    const { vaultId, note, edited, key } = await editedThenKilled(1)

    // What the dead process left: the job claimed and not done, the V1 blocks still there, the note pending.
    const left = await jobByKey(key)
    expect(left).toMatchObject({ attempts: 1, doneAt: null, lastError: null })
    expect(left!.leaseUntil!.getTime()).toBeGreaterThan(Date.now())
    expect(await blockState(note.id)).toEqual({ seqs: [String(note.seq)], keys: keysOf(note, V1) })
    expect(await embeddingState([vaultId])).toEqual({ notes: 1, pending: 1, failed: 0 })

    await reboot(key)

    await expectCurrent(note, edited.seq)
    expect(await jobByKey(key)).toMatchObject({ attempts: 2, lastError: null, doneAt: expect.any(Date) })
    expect(await embeddingState([vaultId])).toEqual({ notes: 1, pending: 0, failed: 0 })
  })

  it(`killed ${MAX_JOB_ATTEMPTS - 1} times in a row: the boot after that still embeds the edit`, async () => {
    const { note, edited, key } = await editedThenKilled(MAX_JOB_ATTEMPTS - 1)
    await reboot(key) // the second run dies too
    expect(await jobByKey(key)).toMatchObject({ attempts: 2, doneAt: null })
    expect((await blockState(note.id)).seqs).toEqual([String(note.seq)])

    await reboot(key)

    await expectCurrent(note, edited.seq)
    expect(await jobByKey(key)).toMatchObject({ attempts: MAX_JOB_ATTEMPTS, lastError: null, doneAt: expect.any(Date) })
  })

  it(`killed ${MAX_JOB_ATTEMPTS} times: LeaseExpired, not re-run at boot, reported; the doctor's repair embeds the edit`, async () => {
    const { vaultId, note, edited, key } = await editedThenKilled(MAX_JOB_ATTEMPTS)
    for (let run = 2; run <= MAX_JOB_ATTEMPTS; run++) await reboot(key)
    // Two more boots: the first marks it LeaseExpired, neither runs it again.
    await reboot(key)
    await reboot(key)

    const failed = await jobByKey(key)
    expect(failed).toMatchObject({ attempts: MAX_JOB_ATTEMPTS, doneAt: expect.any(Date) })
    expect(failed!.lastError).toMatch(/^LeaseExpired: /)
    // Not silent: the note keeps its V1 blocks and is reported as failed.
    expect(await blockState(note.id)).toEqual({ seqs: [String(note.seq)], keys: keysOf(note, V1) })
    expect(await embeddingState([vaultId])).toEqual({ notes: 1, pending: 0, failed: 1 })
    const report = await runDoctor({ vaultId, repair: true })
    expect(report.problems).toContainEqual(expect.objectContaining({ class: 'vector-failed', path: note.path }))

    // The repair queues the job again; the running server's worker picks it up.
    kickEmbeddings()
    await flushEmbeddings()

    await expectCurrent(note, edited.seq)
    expect(await embeddingState([vaultId])).toEqual({ notes: 1, pending: 0, failed: 0 })
  })
})

describe('a note whose seq moved with no job queued is embedded at its current text at boot (#463)', () => {
  // The boot catch-up's staleness check (blocks of the note's current seq), not a job row, is what finds it:
  // a body changed in SQL (backup.md's rollback, code from before #494) moves `seq` through the 0021 trigger
  // and queues nothing.
  it('a body changed by SQL: the next boot embeds the new text', async () => {
    const { vaultId, note } = await embeddedNote()
    await db.execute(sql`UPDATE notes SET body = ${V2} WHERE id = ${note.id}`)
    const [row] = (await db.execute(sql`SELECT seq FROM notes WHERE id = ${note.id}`)) as unknown as [{ seq: string }]
    const seq = Number(row.seq)
    expect(seq).toBeGreaterThan(note.seq)
    const key = embeddingJobKey(note.id, seq)
    expect(await jobByKey(key)).toBeUndefined()
    expect(await blockState(note.id)).toEqual({ seqs: [String(note.seq)], keys: keysOf(note, V1) })
    expect(await embeddingState([vaultId])).toEqual({ notes: 1, pending: 1, failed: 0 })

    expect(await scheduleMissingEmbeddings()).toBeGreaterThanOrEqual(1)
    await flushEmbeddings()

    await expectCurrent(note, seq)
    expect(await jobByKey(key)).toMatchObject({ attempts: 1, lastError: null, doneAt: expect.any(Date) })
    expect(await embeddingState([vaultId])).toEqual({ notes: 1, pending: 0, failed: 0 })
  })
})
