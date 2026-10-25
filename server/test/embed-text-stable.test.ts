// #459: what a note or a file embeds carries no timestamp or other volatile
// row field, so the same content embeds the same texts whenever it was
// written, and a timestamp-only change embeds nothing. Every stored vector
// comes from one of two recipes: note blocks (notes/note-blocks.ts: path,
// heading path, body text; no frontmatter since #452b) and code blocks
// (repositories/code-blocks.ts: path, content, symbol kind, name and start
// line). A symbol's `:<line>` is deliberate (#984) and follows the content.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { blocks, repositories, repositoryFiles, vaults } from '../src/db/schema.js'
import { createNote, updateNote, type WrittenNote } from '../src/notes/store.js'
import { flushExtraction, scheduleMissingExtractions } from '../src/repositories/extraction-queue.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushEmbeddings, scheduleMissingEmbeddings } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser } from './helpers.js'

/** A date, with or without a time: what a timestamp in an embedded text looks like. */
const DATE = /\d{4}-\d{2}-\d{2}/

const createdVaultIds: string[] = []
const createdRepositoryIds: string[] = []
// Other test files leave stale notes and files in the shared database: drain them first, so only this file's texts are recorded.
beforeAll(async () => {
  await scheduleMissingEmbeddings()
  await scheduleMissingExtractions()
  await flushEmbeddings()
  await flushExtraction()
}, 600_000)
afterEach(async () => {
  vi.restoreAllMocks()
  for (const id of createdVaultIds.splice(0)) await db.delete(vaults).where(eq(vaults.id, id))
  for (const id of createdRepositoryIds.splice(0)) await db.delete(repositories).where(eq(repositories.id, id))
})

/** Every text the embedder gets while `run` runs. */
async function embeddedDuring(run: () => Promise<unknown>): Promise<string[]> {
  const texts: string[] = []
  const embed = embedder.embed.bind(embedder)
  const spy = vi.spyOn(embedder, 'embed').mockImplementation(async (batch) => {
    texts.push(...batch)
    return embed(batch)
  })
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
  return texts
}

/** The embed keys of an owner's blocks, sorted (block ids carry the owner, embed keys only the model and text). */
async function embedKeys(ownerType: 'note' | 'code', ownerId: string): Promise<Array<string | null>> {
  const rows = await db
    .select({ embedKey: blocks.embedKey })
    .from(blocks)
    .where(and(eq(blocks.ownerType, ownerType), eq(blocks.ownerId, ownerId)))
  return rows.map((r) => r.embedKey).sort()
}

async function ownerVersions(noteId: string): Promise<string[]> {
  const rows = await db
    .select({ ownerVersion: blocks.ownerVersion })
    .from(blocks)
    .where(and(eq(blocks.ownerType, 'note'), eq(blocks.ownerId, noteId)))
  return [...new Set(rows.map((r) => r.ownerVersion))]
}

async function newVault(name: string): Promise<string> {
  const user = await createActiveUser()
  const [vault] = await db.insert(vaults).values({ name, ownerId: user.id }).returning()
  createdVaultIds.push(vault!.id)
  return vault!.id
}

const NOTE_BODY = [
  'Intro about the river delta.',
  '',
  '# Sources',
  'Field notes from the delta survey.',
  '',
  '## Method',
  'Counted birds at dawn.',
  '',
].join('\n')

describe('a note embeds no timestamp (#459)', () => {
  it('two copies written at different times embed the same texts, none with a date', async () => {
    const path = `concepts/stable-copy-${Math.random().toString(36).slice(2)}`
    const [first, second] = [await newVault('stable-a'), await newVault('stable-b')]
    let noteA!: WrittenNote
    const textsA = await embeddedDuring(async () => {
      noteA = await createNote(first, {
        path,
        body: NOTE_BODY,
        frontmatter: { title: 'Delta', timestamp: '2026-01-01T00:00:00.000Z', created: '2026-01-01', updated: '2026-01-02T03:04:05Z' },
      })
      await flushEmbeddings()
    })
    // The second copy gets the auto `timestamp` (store.ts newNoteState): now.
    let noteB!: WrittenNote
    const textsB = await embeddedDuring(async () => {
      noteB = await createNote(second, { path, body: NOTE_BODY, frontmatter: { title: 'Delta', created: '2026-09-09', updated: '2026-10-11T12:13:14Z' } })
      await flushEmbeddings()
    })

    // The copies differ in their timestamps only: `timestamp`, `created`, `updated`.
    expect(noteA.frontmatter).toMatchObject({ timestamp: '2026-01-01T00:00:00.000Z' })
    expect(noteB.frontmatter).toMatchObject({ timestamp: expect.any(String) })
    expect(noteB.frontmatter).not.toMatchObject({ timestamp: '2026-01-01T00:00:00.000Z' })
    // One text per block: the preamble and two sections.
    expect(textsA).toHaveLength(3)
    expect(textsB).toEqual(textsA)
    for (const text of textsA) expect(text).not.toMatch(DATE)
    expect(await embedKeys('note', noteB.id)).toEqual(await embedKeys('note', noteA.id))
  })

  it('a timestamp-only edit (timestamp, created, updated) embeds nothing and keeps every embed key', async () => {
    const vaultId = await newVault('stable-edit')
    const path = `concepts/stable-edit-${Math.random().toString(36).slice(2)}`
    const frontmatter = { title: 'Delta', created: '2026-01-01', updated: '2026-01-02T03:04:05Z' }
    const note = await createNote(vaultId, { path, body: NOTE_BODY, frontmatter })
    await flushEmbeddings()
    const before = await embedKeys('note', note.id)
    expect(before).toHaveLength(3)

    let edited!: WrittenNote | null
    const texts = await embeddedDuring(async () => {
      edited = await updateNote(vaultId, note.path, {
        frontmatter: { ...frontmatter, timestamp: new Date().toISOString(), created: '2026-03-03', updated: new Date().toISOString() },
      })
      await flushEmbeddings()
    })

    expect(edited!.seq).toBeGreaterThan(note.seq)
    expect(texts).toEqual([])
    expect(await embedKeys('note', note.id)).toEqual(before)
    // The blocks moved to the new seq, so the note's embedding is current, not pending.
    expect(await ownerVersions(note.id)).toEqual([String(edited!.seq)])
  })
})

const FILE_PATH = 'src/ledger.ts'
/** Over SMALL_FILE_MAX_LINES lines with a class and its methods: every code recipe (file, file skeleton, symbol, class skeleton). */
const FILE_CONTENT = [
  'export class Ledger {',
  '  open() {',
  '    return 1',
  '  }',
  '  close() {',
  '    return 2',
  '  }',
  '}',
  '',
  'export function total(ledger: Ledger) {',
  '  return ledger.open() + ledger.close()',
  '}',
  ...Array.from({ length: 320 }, () => '// padding'),
  '',
].join('\n')

async function syncedCopy(name: string, sourceModifiedAt: Date) {
  const owner = await createActiveUser()
  const [repo] = await db.insert(repositories).values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
  createdRepositoryIds.push(repo!.id)
  const texts = await embeddedDuring(async () => {
    await syncRepositoryFiles(repo!.id, [{ path: FILE_PATH, content: FILE_CONTENT, sourceModifiedAt }], [FILE_PATH])
    await flushExtraction()
  })
  const [file] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repo!.id))
  return { repo: repo!, file: file!, texts }
}

describe('a repository file embeds no timestamp (#459)', () => {
  it('two copies synced at different times embed the same texts, none with a date', async () => {
    const a = await syncedCopy('stable-code-a', new Date('2026-01-01T00:00:00Z'))
    const b = await syncedCopy('stable-code-b', new Date('2026-10-11T12:13:14Z'))

    expect(b.file.sourceModifiedAt).not.toEqual(a.file.sourceModifiedAt)
    // Each recipe is there: the file, its skeleton, the class skeleton and the symbols.
    expect(a.texts).toEqual(
      expect.arrayContaining([
        `${FILE_PATH}\n${FILE_CONTENT}`,
        expect.stringMatching(new RegExp(`^${FILE_PATH}\\nexport class Ledger \\{\\n`)),
        expect.stringMatching(new RegExp(`^class Ledger in ${FILE_PATH}\\n`)),
        expect.stringMatching(new RegExp(`^class Ledger in ${FILE_PATH}:1\\n`)),
        expect.stringMatching(new RegExp(`^method Ledger\\.open in ${FILE_PATH}:2\\n`)),
        expect.stringMatching(new RegExp(`^function total in ${FILE_PATH}:10\\n`)),
      ]),
    )
    expect([...b.texts].sort()).toEqual([...a.texts].sort())
    for (const text of a.texts) expect(text).not.toMatch(DATE)
    expect(await embedKeys('code', b.file.id)).toEqual(await embedKeys('code', a.file.id))
  })

  it('a re-sync of the same content with a newer modification time embeds nothing', async () => {
    const { repo, file } = await syncedCopy('stable-code-resync', new Date('2026-01-01T00:00:00Z'))
    const before = await embedKeys('code', file.id)
    const texts = await embeddedDuring(async () => {
      await syncRepositoryFiles(repo.id, [{ path: FILE_PATH, content: FILE_CONTENT, sourceModifiedAt: new Date() }], [FILE_PATH])
      await flushExtraction()
    })
    expect(texts).toEqual([])
    expect(await embedKeys('code', file.id)).toEqual(before)
  })
})
