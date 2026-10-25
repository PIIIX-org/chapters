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

/**
 * The other rows that were derived by the shipped versions follow the bump,
 * as if already re-derived: the catch-up then has only this test's rows to do.
 * Rows other test files left stale stay stale (afterEach moves these back).
 */
async function othersCurrent(repositoryId: string | null, vaultId: string | null) {
  await db.execute(sql`UPDATE repository_files SET extractor_version = ${versions.extractor}, embedder_id = ${versions.embedder}
    WHERE embedding IS NOT NULL AND extracted_hash = content_hash
      AND extractor_version = ${shipped.extractor} AND embedder_id = ${shipped.embedder}
      ${repositoryId ? sql`AND repository_id <> ${repositoryId}` : sql``}`)
  await db.execute(sql`UPDATE notes SET embedder_id = ${versions.embedder}
    WHERE embedding IS NOT NULL AND embedder_id = ${shipped.embedder} ${vaultId ? sql`AND vault_id <> ${vaultId}` : sql``}`)
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

  // #449/#451 bumped EXTRACTOR_VERSION to 2: a .tsx file version 1 parsed with
  // the TypeScript grammar lost the symbols after its first JSX element, and
  // gets them at the next boot without a push.
  it('a .tsx row extractor version 1 produced is extracted again with the TSX grammar', async () => {
    const owner = await createActiveUser()
    const [repo] = await db
      .insert(repositories)
      .values({ name: 'versions-tsx-v1', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    const content = [
      'export function Card() {',
      '  return <div className="card"><span>hi</span></div>',
      '}',
      'export default function Page() { return <Card /> }',
      'export interface PageProps { id: string }',
    ].join('\n')
    // Pushed and extracted while version 1 ran: the row and its job key carry 1.
    versions.extractor = 1
    await syncRepositoryFiles(repo!.id, [{ path: 'src/Page.tsx', content }], ['src/Page.tsx'])
    await flushExtraction()
    const [file] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repo!.id))
    expect((await fileVersions(file!.id)).extractor_version).toBe(1)
    // Stand-in for the broken outline version 1's TypeScript grammar left:
    // the declaration before the JSX, none of those after it.
    await db
      .delete(repositoryFileSymbols)
      .where(and(eq(repositoryFileSymbols.fileId, file!.id), inArray(repositoryFileSymbols.name, ['Page', 'PageProps'])))
    const [cardBefore] = await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file!.id))
    versions.extractor = shipped.extractor
    await othersCurrent(repo!.id, null)
    const texts = embeddedTexts()

    expect(await scheduleMissingExtractions()).toBeGreaterThanOrEqual(1)
    await flushExtraction()

    expect(await fileVersions(file!.id)).toEqual({ extractor_version: EXTRACTOR_VERSION, embedder_id: EMBEDDER_ID })
    const symbols = await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file!.id))
    const byLine = symbols.sort((a, b) => a.startLine - b.startLine)
    expect(byLine.map((s) => [s.name, s.kind, s.startLine, s.endLine])).toEqual([
      ['Card', 'function', 1, 3],
      ['Page', 'function', 4, 4],
      ['PageProps', 'interface', 5, 5],
    ])
    // The bump costs a parse: the file vector and Card's vector are kept; only
    // the two symbols the TSX grammar recovers are embedded.
    const embeddedHere = texts.filter((t) => t.includes(file!.path))
    expect(embeddedHere.map((t) => t.split('\n')[0])).toEqual([
      `function Page in ${file!.path}:4`,
      `interface PageProps in ${file!.path}:5`,
    ])
    expect(byLine[0]!.embedding).toEqual(cardBefore!.embedding)
    expect(byLine.every((s) => s.embedding !== null)).toBe(true)
  })

  // #450 bumped EXTRACTOR_VERSION to 3: methods, arrow-function consts and
  // exported consts become symbols. The bump costs a parse: the file vector
  // and the vectors of the symbols version 2 already had are kept; only the
  // new symbols are embedded.
  it('a row extractor version 2 produced keeps its vectors; only the symbols version 3 adds are embedded', async () => {
    const owner = await createActiveUser()
    const [repo] = await db
      .insert(repositories)
      .values({ name: 'versions-symbols-v2', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    const content = [
      'export function keep() { return 1 }',
      'export class Store {',
      '  save() { return keep() }',
      '}',
      'export const load = () => new Store()',
      'export const LIMIT = 3',
    ].join('\n')
    versions.extractor = 2
    await syncRepositoryFiles(repo!.id, [{ path: 'src/store.ts', content }], ['src/store.ts'])
    await flushExtraction()
    const [file] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repo!.id))
    expect((await fileVersions(file!.id)).extractor_version).toBe(2)
    // Stand-in for version 2's outline: only the function and class declarations.
    await db
      .delete(repositoryFileSymbols)
      .where(and(eq(repositoryFileSymbols.fileId, file!.id), inArray(repositoryFileSymbols.name, ['save', 'load', 'LIMIT'])))
    const before = await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file!.id))
    const fileVectorBefore = file!.embedding
    versions.extractor = shipped.extractor
    await othersCurrent(repo!.id, null)
    const texts = embeddedTexts()

    expect(await scheduleMissingExtractions()).toBeGreaterThanOrEqual(1)
    await flushExtraction()

    expect(await fileVersions(file!.id)).toEqual({ extractor_version: EXTRACTOR_VERSION, embedder_id: EMBEDDER_ID })
    // No file text; exported symbols before methods (the embed budget's order).
    expect(texts.filter((t) => t.includes(file!.path)).map((t) => t.split('\n')[0])).toEqual([
      `function load in ${file!.path}:5`,
      `variable LIMIT in ${file!.path}:6`,
      `method Store.save in ${file!.path}:3`,
    ])
    const [after] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.id, file!.id))
    expect(after!.embedding).toEqual(fileVectorBefore)
    const symbols = await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file!.id))
    const vectorOf = (rows: typeof symbols, name: string) => rows.find((s) => s.name === name)?.embedding
    expect(vectorOf(symbols, 'keep')).toEqual(vectorOf(before, 'keep'))
    expect(vectorOf(symbols, 'Store')).toEqual(vectorOf(before, 'Store'))
    expect(symbols.map((s) => s.name).sort()).toEqual(['LIMIT', 'Store', 'keep', 'load', 'save'])
    expect(symbols.every((s) => s.embedding !== null)).toBe(true)
  })

  // #451: before it, `.mts`/`.cts` had no language, so their rows carry
  // `language` NULL. A sync skips unchanged content and never relabels them;
  // the catch-up derives the language from the path and writes it back.
  it('a .mts row indexed with no language is labelled typescript and extracted at boot', async () => {
    const owner = await createActiveUser()
    const [repo] = await db
      .insert(repositories)
      .values({ name: 'versions-mts-null-language', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    const content = "import { load } from './load.mjs'\nexport function gen() { return load() }\n"
    versions.extractor = 1
    await syncRepositoryFiles(repo!.id, [{ path: 'tools/gen.mts', content }], ['tools/gen.mts'])
    await flushExtraction()
    const [file] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repo!.id))
    // What version 1 left: no language, so a file vector and nothing else.
    await db.delete(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file!.id))
    await db.execute(sql`UPDATE repository_files SET language = NULL WHERE id = ${file!.id}`)
    expect(await fileVersions(file!.id)).toEqual({ extractor_version: 1, embedder_id: EMBEDDER_ID })
    versions.extractor = shipped.extractor
    await othersCurrent(repo!.id, null)
    const texts = embeddedTexts()

    expect(await scheduleMissingExtractions()).toBeGreaterThanOrEqual(1)
    await flushExtraction()

    const [after] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.id, file!.id))
    expect([after!.language, after!.extractorVersion]).toEqual(['typescript', EXTRACTOR_VERSION])
    expect(after!.embedding).toEqual(file!.embedding)
    const symbols = await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file!.id))
    expect(symbols.map((s) => [s.name, s.kind, s.startLine])).toEqual([['gen', 'function', 2]])
    // Only the new symbol is embedded, not the file again.
    expect(texts.filter((t) => t.includes(file!.path)).map((t) => t.split('\n')[0])).toEqual([`function gen in ${file!.path}:2`])

    // A later sync of the same content changes nothing.
    await syncRepositoryFiles(repo!.id, [{ path: 'tools/gen.mts', content }], ['tools/gen.mts'])
    await flushExtraction()
    const [resynced] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.id, file!.id))
    expect([resynced!.language, resynced!.extractorVersion]).toEqual(['typescript', EXTRACTOR_VERSION])
    expect(await db.select().from(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, file!.id))).toHaveLength(1)
  })
})

describe('files extracted before migration 0033 (#453)', () => {
  /** A file as 0033 leaves it: its vector and the id from the catalog default, no `extracted_hash`, version 0, only pre-0033 jobs. */
  async function legacyFile(name: string) {
    const { repo, files } = await extractedRepo(name)
    const file = files[0]!
    await db.update(repositoryFiles).set({ extractedHash: null, extractorVersion: 0 }).where(eq(repositoryFiles.id, file.id))
    await db.delete(jobs).where(sql`${jobs.payload}->>'fileId' = ${file.id}`)
    return { repo, file }
  }

  it('re-extracted once at boot, keeping its file and symbol vectors', async () => {
    const { file } = await legacyFile('legacy-current')
    const texts = embeddedTexts()
    await scheduleMissingExtractions()
    await flushExtraction()
    expect(texts.filter((t) => t.includes(file.path))).toEqual([])
    const [row] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.id, file.id))
    expect(row).toMatchObject({ extractedHash: file.contentHash, extractorVersion: EXTRACTOR_VERSION, embedderId: EMBEDDER_ID })
  })

  it('its vector is embedded again when its pre-0033 job for the current content failed', async () => {
    const { repo, file } = await legacyFile('legacy-failed')
    await db.insert(jobs).values({
      kind: 'extract',
      payload: { fileId: file.id, repositoryId: repo.id },
      idempotencyKey: `extract:${file.id}:${file.contentHash}`,
      attempts: MAX_JOB_ATTEMPTS,
      lastError: 'Error: model download failed',
      doneAt: new Date(),
    })
    const texts = embeddedTexts()
    await scheduleMissingExtractions()
    await flushExtraction()
    expect(texts.filter((t) => t === `${file.path}\n${SOURCE}`)).toHaveLength(1)
  })

  it('a push before its re-extraction records the content its vector was made from, so the new content is embedded', async () => {
    const { repo, file } = await legacyFile('legacy-pushed')
    const texts = embeddedTexts()
    const changed = `${SOURCE}// changed\n`
    await syncRepositoryFiles(repo.id, [{ path: file.path, content: changed }], [file.path])
    await flushExtraction()
    expect(texts.filter((t) => t === `${file.path}\n${changed}`)).toHaveLength(1)
    const [row] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.id, file.id))
    expect(row!.extractedHash).toBe(createHash('sha256').update(changed).digest('hex'))
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
