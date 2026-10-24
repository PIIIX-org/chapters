// ADR-003 S5 (#494): repository extraction and note embedding run from rows
// of the `jobs` table, not from in-process arrays. These tests use the queue
// entry points, their job keys (#453) and SQL on `jobs`.
import { createHash } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { jobs, notes, repositories, repositoryFiles, vaults } from '../src/db/schema.js'
import {
  extractionJobKey,
  flushExtraction,
  scheduleExtraction,
  scheduleMissingExtractions,
} from '../src/repositories/extraction-queue.js'
import { embeddingJobKey, flushEmbeddings, scheduleEmbedding } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser, fileEmbedding } from './helpers.js'

const createdVaultIds: string[] = []
// The boot catch-up these tests call queues every stale file of the shared test database, other files' included:
// drain that backlog first, so a test's flush waits only for its own file (CI run 40098011837 timed out here).
beforeAll(async () => {
  await scheduleMissingExtractions()
  await flushExtraction()
}, 600_000)
afterEach(async () => {
  vi.restoreAllMocks()
  for (const id of createdVaultIds.splice(0)) await db.delete(vaults).where(eq(vaults.id, id))
})

/** A repository with one file persisted by a sync whose extraction never ran. */
async function fileWithoutExtraction(name: string) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  const path = `src/${name}-${Math.random().toString(36).slice(2)}.ts`
  const content = `export function ${name.replace(/\W/g, '_')}() { return 1 }`
  const contentHash = createHash('sha256').update(content).digest('hex')
  const [file] = await db
    .insert(repositoryFiles)
    .values({ repositoryId: repo!.id, path, language: 'typescript', content, contentHash, size: content.length })
    .returning()
  return { repo: repo!, file: file!, key: extractionJobKey(file!.id, contentHash) }
}

/** Counts embedder calls whose first text is the given file's `${path}\n…`. */
function countEmbedsOf(path: string) {
  const calls = { n: 0 }
  const embed = embedder.embed.bind(embedder)
  vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
    if (texts[0]!.split('\n', 1)[0] === path) calls.n++
    return embed(texts)
  })
  return calls
}

async function jobByKey(key: string) {
  return (await db.select().from(jobs).where(eq(jobs.idempotencyKey, key)))[0]
}

describe('durable extraction jobs (#494)', () => {
  it('a duplicate enqueue of the same file and content is a no-op', async () => {
    const { file, key } = await fileWithoutExtraction('dup')
    const calls = countEmbedsOf(file.path)

    scheduleExtraction(file.id)
    scheduleExtraction(file.id)
    await scheduleMissingExtractions()
    await flushExtraction()

    expect(calls.n).toBe(1)
    const rows = await db.select().from(jobs).where(sql`${jobs.payload}->>'fileId' = ${file.id}`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.idempotencyKey).toBe(key)
    expect(rows[0]!.doneAt).not.toBeNull()
    expect(rows[0]!.attempts).toBe(1)
  })

  it('a job a dead process left leased is completed once after the restart', async () => {
    const { repo, file, key } = await fileWithoutExtraction('restart')
    // What a process killed mid-extraction leaves behind: claimed, lease run out, not done.
    await db.insert(jobs).values({
      kind: 'extract',
      payload: { fileId: file.id, repositoryId: repo.id },
      idempotencyKey: key,
      attempts: 1,
      leaseUntil: new Date(Date.now() - 1000),
    })
    const calls = countEmbedsOf(file.path)

    // Boot path, twice (a second boot must not redo finished work).
    await scheduleMissingExtractions()
    await flushExtraction()
    await scheduleMissingExtractions()
    await flushExtraction()

    expect(calls.n).toBe(1)
    const job = await jobByKey(key)
    expect(job?.doneAt).not.toBeNull()
    expect(job?.attempts).toBe(2)
    expect(job?.lastError).toBeNull()
    expect(await fileEmbedding(file.id)).not.toBeNull()
  })

  it('a live lease is not reclaimed; once it expires the job runs', async () => {
    const { repo, file, key } = await fileWithoutExtraction('lease')
    await db.insert(jobs).values({
      kind: 'extract',
      payload: { fileId: file.id, repositoryId: repo.id },
      idempotencyKey: key,
      attempts: 1,
      leaseUntil: new Date(Date.now() + 3_600_000),
    })
    const calls = countEmbedsOf(file.path)

    await scheduleMissingExtractions()
    await flushExtraction()
    expect(calls.n).toBe(0)
    expect((await jobByKey(key))?.doneAt).toBeNull()

    await db.update(jobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(jobs.idempotencyKey, key))
    await scheduleMissingExtractions()
    await flushExtraction()
    expect(calls.n).toBe(1)
    expect((await jobByKey(key))?.doneAt).not.toBeNull()
  })
})

describe('durable note embedding jobs (#494)', () => {
  it('one job per note version; a duplicate enqueue is a no-op', async () => {
    const user = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'jobs-embed-vault', ownerId: user.id }).returning()
    createdVaultIds.push(vault!.id)
    const [note] = await db
      .insert(notes)
      .values({ vaultId: vault!.id, type: 'note', name: 'n', path: `jobs-${Date.now()}.md`, body: 'durable', frontmatter: {} })
      .returning()
    const calls = countEmbedsOf(note!.path)

    scheduleEmbedding(note!.id)
    scheduleEmbedding(note!.id)
    await flushEmbeddings()

    expect(calls.n).toBe(1)
    const rows = await db.select().from(jobs).where(sql`${jobs.payload}->>'noteId' = ${note!.id}`)
    expect(rows).toHaveLength(1)
    // `notes.seq` (migration 0021) is not in the Drizzle schema yet.
    const [{ seq }] = (await db.execute(sql`SELECT seq FROM notes WHERE id = ${note!.id}`)) as unknown as [{ seq: string }]
    expect(rows[0]!.idempotencyKey).toBe(embeddingJobKey(note!.id, seq))
    expect(rows[0]!.doneAt).not.toBeNull()
  })
})
