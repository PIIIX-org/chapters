// #453: every derived artifact is keyed by what produced it. A repository
// file's imports, symbols and vector carry `EXTRACTOR_VERSION` and
// `EMBEDDER_ID` (on its `repository_files` row, written with them in one
// transaction); a note's vector carries `EMBEDDER_ID`. Both go into the job
// keys, and boot catch-up re-derives rows a different version produced, in
// batches, once (the jobs dedupe by key).
//
// The tests bump the versions for real: the two modules are mocked with a
// getter, which the queues read at each call.
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { jobs, notes, repositories, repositoryFiles, repositoryFileSymbols, vaults } from '../src/db/schema.js'
import { MAX_JOB_ATTEMPTS, catchUpLimits, jobTiming } from '../src/jobs/durable.js'
import { createNote } from '../src/notes/store.js'
import {
  extractionJobKey,
  flushExtraction,
  scheduleMissingExtractions,
} from '../src/repositories/extraction-queue.js'
import { EXTRACTOR_VERSION } from '../src/repositories/extraction.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { embeddingJobKey, flushEmbeddings, scheduleMissingEmbeddings } from '../src/search/embedding-queue.js'
import { EMBEDDER_ID, embedder } from '../src/search/embeddings.js'
import type * as Embeddings from '../src/search/embeddings.js'
import type * as Extraction from '../src/repositories/extraction.js'
import { createActiveUser } from './helpers.js'

const versions = vi.hoisted(() => ({ extractor: 0, embedder: '' }))

vi.mock('../src/repositories/extraction.js', async (importOriginal) => {
  const real = await importOriginal<typeof Extraction>()
  versions.extractor = real.EXTRACTOR_VERSION
  return {
    ...real,
    get EXTRACTOR_VERSION() {
      return versions.extractor
    },
  }
})

vi.mock('../src/search/embeddings.js', async (importOriginal) => {
  const real = await importOriginal<typeof Embeddings>()
  versions.embedder = real.EMBEDDER_ID
  return {
    ...real,
    get EMBEDDER_ID() {
      return versions.embedder
    },
  }
})

const shipped = { ...versions }
const savedBackoff = jobTiming.backoffBaseMs
const savedBatch = catchUpLimits.batchSize
const createdVaultIds: string[] = []
beforeEach(() => {
  jobTiming.backoffBaseMs = 0
})
afterEach(async () => {
  jobTiming.backoffBaseMs = savedBackoff
  catchUpLimits.batchSize = savedBatch
  vi.restoreAllMocks()
  // Rows the test marked as derived by the bumped version count as derived by the shipped one again.
  await db.execute(sql`UPDATE repository_files SET extractor_version = ${shipped.extractor}, embedder_id = ${shipped.embedder}
    WHERE extractor_version = ${versions.extractor} AND embedder_id = ${versions.embedder} AND embedding IS NOT NULL`)
  await db.execute(sql`UPDATE notes SET embedder_id = ${shipped.embedder} WHERE embedder_id = ${versions.embedder} AND embedding IS NOT NULL`)
  Object.assign(versions, shipped)
  for (const id of createdVaultIds.splice(0)) await db.delete(vaults).where(eq(vaults.id, id))
})

const SOURCE = "import { b } from './b'\nexport function unchanged() { return b() }\n"

async function extractedRepo(name: string, count = 1) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  const paths = Array.from({ length: count }, (_, i) => `src/f${i}.ts`)
  await syncRepositoryFiles(
    repo!.id,
    paths.map((path) => ({ path, content: SOURCE })),
    paths,
  )
  await flushExtraction()
  const files = await db.select().from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repo!.id))
  return { repo: repo!, files }
}

async function fileVersions(fileId: string) {
  const [row] = (await db.execute(
    sql`SELECT extractor_version, embedder_id FROM repository_files WHERE id = ${fileId}`,
  )) as unknown as [{ extractor_version: number; embedder_id: string | null }]
  return row
}

async function noteVersion(noteId: string) {
  const [row] = (await db.execute(sql`SELECT embedder_id, seq FROM notes WHERE id = ${noteId}`)) as unknown as [
    { embedder_id: string | null; seq: string },
  ]
  return row
}

/** Counts the embeds whose first text is the file's text `file`, and those whose first text starts with `notePrefix`. */
function countEmbeds(file: string, notePrefix?: string) {
  const calls = { file: 0, note: 0 }
  const embed = embedder.embed.bind(embedder)
  vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
    if (texts[0] === file) calls.file++
    if (notePrefix !== undefined && texts[0]!.startsWith(notePrefix)) calls.note++
    return embed(texts)
  })
  return calls
}

/** Every text the embedder is asked for from now on, in order. */
function embeddedTexts(): string[] {
  const texts: string[] = []
  const embed = embedder.embed.bind(embedder)
  vi.spyOn(embedder, 'embed').mockImplementation(async (batch) => {
    texts.push(...batch)
    return embed(batch)
  })
  return texts
}

/** Every row outside `repositoryId` counts as derived by the current versions: the catch-up then only has this test's rows to do. */
async function othersCurrent(repositoryId: string | null, vaultId: string | null) {
  await db.execute(sql`UPDATE repository_files SET extractor_version = ${versions.extractor}, embedder_id = ${versions.embedder},
    extracted_hash = content_hash
    WHERE embedding IS NOT NULL ${repositoryId ? sql`AND repository_id <> ${repositoryId}` : sql``}`)
  await db.execute(sql`UPDATE notes SET embedder_id = ${versions.embedder}
    WHERE embedding IS NOT NULL ${vaultId ? sql`AND vault_id <> ${vaultId}` : sql``}`)
}

describe('derived rows record what produced them (#453)', () => {
  it('a file records EXTRACTOR_VERSION and EMBEDDER_ID; its job key carries both', async () => {
    const { files } = await extractedRepo('versions-keys')
    const file = files[0]!
    expect(await fileVersions(file.id)).toEqual({ extractor_version: EXTRACTOR_VERSION, embedder_id: EMBEDDER_ID })
    const key = extractionJobKey(file.id, file.contentHash)
    expect(key).toBe(`extract:${file.id}:${file.contentHash}:${EXTRACTOR_VERSION}:${EMBEDDER_ID}`)
    const [job] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, key))
    expect(job?.doneAt).not.toBeNull()
    expect(job?.lastError).toBeNull()
  })

  it('a note records EMBEDDER_ID; the job its write queues carries it', async () => {
    const user = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'versions-note-vault', ownerId: user.id }).returning()
    createdVaultIds.push(vault!.id)
    const note = await createNote(vault!.id, { path: `versions-${Date.now()}`, body: 'a versioned note' })
    await flushEmbeddings()
    const key = embeddingJobKey(note.id, note.seq)
    expect(key).toBe(`embed_note:${note.id}:${note.seq}:${EMBEDDER_ID}`)
    const [job] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, key))
    expect(job?.doneAt).not.toBeNull()
    expect((await noteVersion(note.id)).embedder_id).toBe(EMBEDDER_ID)
  })
})

describe('boot catch-up re-derives rows of another version (#453)', () => {
  it('EXTRACTOR_VERSION bumped: an unchanged file is extracted again once, and its vectors are kept (no embedding)', async () => {
    const { repo, files } = await extractedRepo('versions-extractor-bump')
    const file = files[0]!
    const symbolsBefore = await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file.id))
    versions.extractor = shipped.extractor + 1
    await othersCurrent(repo.id, null)
    const texts = embeddedTexts()

    expect(await scheduleMissingExtractions()).toBeGreaterThanOrEqual(1)
    await flushExtraction()

    expect(texts.filter((t) => t.includes(file.path))).toEqual([])
    expect(await fileVersions(file.id)).toEqual({ extractor_version: versions.extractor, embedder_id: EMBEDDER_ID })
    const symbols = await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file.id))
    expect(symbols.map((s) => [s.name, s.embedding])).toEqual(symbolsBefore.map((s) => [s.name, s.embedding]))
    const [job] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, extractionJobKey(file.id, file.contentHash)))
    expect(job?.idempotencyKey).toBe(`extract:${file.id}:${file.contentHash}:${versions.extractor}:${EMBEDDER_ID}`)
    expect(job?.doneAt).not.toBeNull()

    // The next boot finds it current: nothing runs again.
    const [again] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, extractionJobKey(file.id, file.contentHash)))
    await scheduleMissingExtractions()
    await flushExtraction()
    const [after] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, extractionJobKey(file.id, file.contentHash)))
    expect(after?.id).toBe(again?.id)
  })

  it('EXTRACTOR_VERSION bumped: only a symbol whose embed text is new is embedded', async () => {
    const { repo, files } = await extractedRepo('versions-extractor-new-symbol')
    const file = files[0]!
    // What the previous extractor left: one symbol fewer than the new one finds.
    await db.delete(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file.id))
    versions.extractor = shipped.extractor + 1
    await othersCurrent(repo.id, null)
    const texts = embeddedTexts()

    await scheduleMissingExtractions()
    await flushExtraction()

    expect(texts.filter((t) => t.includes(file.path))).toEqual([`function unchanged in ${file.path}:2\n${SOURCE.split('\n')[1]}`])
    const symbols = await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file.id))
    expect(symbols.map((s) => s.name)).toEqual(['unchanged'])
    expect(symbols[0]!.embedding).not.toBeNull()
  })

  it('EMBEDDER_ID bumped: files and notes are embedded again, once', async () => {
    const { repo, files } = await extractedRepo('versions-embedder-bump')
    const file = files[0]!
    const user = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'versions-embedder-vault', ownerId: user.id }).returning()
    createdVaultIds.push(vault!.id)
    const note = await createNote(vault!.id, { path: `embedder-${Date.now()}`, body: 'embedded by the old model' })
    await flushEmbeddings()
    expect((await noteVersion(note.id)).embedder_id).toBe(shipped.embedder)

    versions.embedder = `${shipped.embedder}-next`
    await othersCurrent(repo.id, vault!.id)
    const calls = countEmbeds(`${file.path}\n${SOURCE}`, `${note.path}\n`)

    await scheduleMissingEmbeddings()
    await scheduleMissingExtractions()
    await flushEmbeddings()
    await flushExtraction()

    expect(calls).toEqual({ file: 1, note: 1 })
    expect((await fileVersions(file.id)).embedder_id).toBe(versions.embedder)
    const after = await noteVersion(note.id)
    expect(after.embedder_id).toBe(versions.embedder)
    const [job] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, embeddingJobKey(note.id, after.seq)))
    expect(job?.idempotencyKey).toBe(`embed_note:${note.id}:${after.seq}:${versions.embedder}`)
    expect(job?.doneAt).not.toBeNull()

    await scheduleMissingEmbeddings()
    await scheduleMissingExtractions()
    await flushEmbeddings()
    await flushExtraction()
    expect(calls).toEqual({ file: 1, note: 1 })
  })

  it('works in batches: a page smaller than the backlog still reaches every file', async () => {
    const { repo, files } = await extractedRepo('versions-batches', 5)
    versions.extractor = shipped.extractor + 1
    await othersCurrent(repo.id, null)
    catchUpLimits.batchSize = 2

    expect(await scheduleMissingExtractions()).toBeGreaterThanOrEqual(5)
    const keys = files.map((f) => extractionJobKey(f.id, f.contentHash))
    expect(await db.select().from(jobs).where(inArray(jobs.idempotencyKey, keys))).toHaveLength(5)
    await flushExtraction()
    for (const f of files) expect((await fileVersions(f.id)).extractor_version).toBe(versions.extractor)
  })

  it('a LeaseExpired job is not re-run at boot; a version bump gives the file a new job', async () => {
    const owner = await createActiveUser()
    const [repo] = await db
      .insert(repositories)
      .values({ name: 'versions-lease-expired', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    const content = 'kills the process'
    const contentHash = createHash('sha256').update(content).digest('hex')
    const [file] = await db
      .insert(repositoryFiles)
      .values({ repositoryId: repo!.id, path: 'crash.txt', language: null, content, contentHash, size: content.length })
      .returning()
    // What MAX_JOB_ATTEMPTS runs that each took the process down leave, after failCrashedJobs.
    await db.insert(jobs).values({
      kind: 'extract',
      payload: { fileId: file!.id, repositoryId: repo!.id },
      idempotencyKey: extractionJobKey(file!.id, contentHash),
      attempts: MAX_JOB_ATTEMPTS,
      lastError: `LeaseExpired: the process running this job stopped before it finished, ${MAX_JOB_ATTEMPTS} times`,
      doneAt: new Date(),
    })
    const calls = countEmbeds(`crash.txt\n${content}`)

    await scheduleMissingExtractions()
    await flushExtraction()
    expect(calls.file).toBe(0)

    versions.extractor = shipped.extractor + 1
    await othersCurrent(repo!.id, null)
    await scheduleMissingExtractions()
    await flushExtraction()
    expect(calls.file).toBe(1)
    expect(await fileVersions(file!.id)).toEqual({ extractor_version: versions.extractor, embedder_id: EMBEDDER_ID })
    const pending = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, 'extract'), sql`${jobs.payload}->>'fileId' = ${file!.id}`, sql`${jobs.doneAt} IS NULL`))
    expect(pending).toHaveLength(0)
  })
})

describe('the note model is unchanged (#453)', () => {
  it('notes.embedder_id is not part of the note rows the API returns', async () => {
    const user = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'versions-shape-vault', ownerId: user.id }).returning()
    createdVaultIds.push(vault!.id)
    const note = await createNote(vault!.id, { path: `shape-${Date.now()}`, body: 'shape' })
    await flushEmbeddings()
    const [row] = await db.select().from(notes).where(eq(notes.id, note.id))
    expect(Object.keys(row!)).not.toContain('embedderId')
    expect(Object.keys(note)).not.toContain('embedderId')
  })
})
