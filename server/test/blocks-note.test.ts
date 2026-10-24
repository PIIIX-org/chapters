// ADR-004 wave 4b (#452): a note's vectors are its heading blocks. A
// `preamble` (text before the first heading) and one `section` per heading,
// with stable ids: an edit in another section or in the frontmatter keeps
// every other block's id, and re-embeds only the blocks whose text changed
// (a frontmatter-only edit embeds nothing). The block set is written by the
// embed job for its `seq`, whole; a job for a seq the note has moved past
// never overwrites newer blocks. The note vector leg ranks a note by its best
// block: one hit per note.
// Uses only entry points that existed before note blocks (the fails-before
// job runs this file against the base source).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { blocks, notes, vaults } from '../src/db/schema.js'
import { jobTiming } from '../src/jobs/durable.js'
import { flushEmbeddings, scheduleEmbedding } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

const savedBackoff = jobTiming.backoffBaseMs
const createdVaultIds: string[] = []
beforeEach(() => {
  jobTiming.backoffBaseMs = 0
})
afterEach(async () => {
  jobTiming.backoffBaseMs = savedBackoff
  vi.restoreAllMocks()
  for (const id of createdVaultIds.splice(0)) await db.delete(vaults).where(eq(vaults.id, id))
})

const BODY = [
  'Intro line before any heading.',
  '',
  '# Alpha',
  'Alpha own text about apples.',
  '',
  '## Beta',
  'Beta text about bananas.',
  '',
  '# Gamma',
  'Gamma text about grapes.',
  '',
].join('\n')

async function makeNote(body: string, frontmatter: Record<string, unknown> = { status: 'draft' }) {
  const user = await createActiveUser()
  const [vault] = await db.insert(vaults).values({ name: 'note-blocks-vault', ownerId: user.id }).returning()
  createdVaultIds.push(vault!.id)
  const [note] = await db
    .insert(notes)
    .values({ vaultId: vault!.id, type: 'concepts', name: 'n', path: `concepts/n-${Date.now()}-${Math.random().toString(36).slice(2)}`, body, frontmatter })
    .returning()
  return { vaultId: vault!.id, note: { id: note!.id, seq: await seqOf(note!.id) } }
}

async function embedNow(noteId: string) {
  scheduleEmbedding(noteId)
  await flushEmbeddings()
}

async function noteBlockRows(noteId: string) {
  return db
    .select({ id: blocks.id, blockId: blocks.blockId, kind: blocks.kind, innerPath: blocks.innerPath, startLine: blocks.startLine, endLine: blocks.endLine, ownerVersion: blocks.ownerVersion, embedded: sql<boolean>`${blocks.embedding} IS NOT NULL` })
    .from(blocks)
    .where(and(eq(blocks.ownerType, 'note'), eq(blocks.ownerId, noteId)))
    .orderBy(asc(blocks.startLine), asc(blocks.innerPath))
}

async function seqOf(noteId: string): Promise<string> {
  const [row] = (await db.execute(sql`SELECT seq FROM notes WHERE id = ${noteId}`)) as unknown as [{ seq: string }]
  return String(row.seq)
}

/** Every text the embedder gets while `run` runs. */
async function embeddedDuring(run: () => Promise<void>): Promise<string[]> {
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

describe('a note is stored as heading blocks (#452)', () => {
  it('a preamble and one section per heading; nested sections overlap their parent; body-relative lines', async () => {
    const { note } = await makeNote(BODY)
    await embedNow(note.id)
    const rows = await noteBlockRows(note.id)
    expect(rows.map((b) => [b.kind, b.innerPath, b.startLine, b.endLine])).toEqual([
      ['preamble', '', 1, 2],
      ['section', 'Alpha', 3, 8],
      ['section', 'Alpha > Beta', 6, 8],
      ['section', 'Gamma', 9, 10],
    ])
    expect(rows.every((b) => b.embedded && b.ownerVersion === String(note.seq))).toBe(true)
  })

  it('duplicate headings get a sibling index; headings inside code fences are not sections', async () => {
    const body = ['# Notes', 'first', '```md', '# Not a heading', '```', '# Notes', 'second', ''].join('\n')
    const { note } = await makeNote(body)
    await embedNow(note.id)
    const rows = await noteBlockRows(note.id)
    expect(rows.map((b) => [b.kind, b.innerPath, b.startLine, b.endLine])).toEqual([
      ['section', 'Notes', 1, 5],
      ['section', 'Notes', 6, 7],
    ])
    expect(new Set(rows.map((b) => b.blockId)).size).toBe(2)
  })
})

describe('block ids are stable and only changed texts are embedded (#452)', () => {
  it('an edit in one section keeps every block id and embeds only that section', async () => {
    const { note } = await makeNote(BODY)
    await embedNow(note.id)
    const before = await noteBlockRows(note.id)

    await db.update(notes).set({ body: BODY.replace('Gamma text about grapes.', 'Gamma text about grapes and figs.') }).where(eq(notes.id, note.id))
    const texts = await embeddedDuring(() => embedNow(note.id))
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('Gamma text about grapes and figs.')
    expect(texts[0]).not.toContain('apples')

    const after = await noteBlockRows(note.id)
    expect(after.map((b) => [b.blockId, b.id])).toEqual(before.map((b) => [b.blockId, b.id]))
    expect(after.every((b) => b.ownerVersion === after[0]!.ownerVersion && b.ownerVersion !== before[0]!.ownerVersion)).toBe(true)
  })

  it('an edit that shifts lines above a section keeps its id and embeds only the edited block', async () => {
    const { note } = await makeNote(BODY)
    await embedNow(note.id)
    const before = await noteBlockRows(note.id)

    await db.update(notes).set({ body: BODY.replace('Intro line before any heading.', 'Intro line.\nA second intro line.') }).where(eq(notes.id, note.id))
    const texts = await embeddedDuring(() => embedNow(note.id))
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('A second intro line.')

    const after = await noteBlockRows(note.id)
    expect(after.map((b) => b.blockId)).toEqual(before.map((b) => b.blockId))
    expect(after.find((b) => b.innerPath === 'Gamma')!.startLine).toBe(before.find((b) => b.innerPath === 'Gamma')!.startLine + 1)
  })

  it('a frontmatter-only edit embeds nothing and keeps every block, moved to the new seq', async () => {
    const { note } = await makeNote(BODY)
    await embedNow(note.id)
    const before = await noteBlockRows(note.id)

    await db.update(notes).set({ frontmatter: { status: 'final', timestamp: new Date().toISOString() } }).where(eq(notes.id, note.id))
    const texts = await embeddedDuring(() => embedNow(note.id))
    expect(texts).toEqual([])

    const after = await noteBlockRows(note.id)
    const seq = await seqOf(note.id)
    expect(seq).not.toBe(String(note.seq))
    expect(after.map((b) => [b.blockId, b.id, b.startLine, b.endLine])).toEqual(before.map((b) => [b.blockId, b.id, b.startLine, b.endLine]))
    expect(after.every((b) => b.embedded && b.ownerVersion === seq)).toBe(true)
  })
})

describe('the block set is written for its seq only (#452, #460)', () => {
  it('a job for a seq the note has moved past embeds nothing and leaves the newer blocks', async () => {
    const { note } = await makeNote(BODY)
    await db.update(notes).set({ body: `${BODY}# Delta\nDelta text.\n` }).where(eq(notes.id, note.id))
    await embedNow(note.id)
    const newer = await noteBlockRows(note.id)
    expect(newer.map((b) => b.innerPath)).toContain('Delta')

    // The job the first write queued (seq 1) runs only now.
    await db.execute(sql`INSERT INTO jobs (kind, payload, idempotency_key)
      VALUES ('embed_note', jsonb_build_object('noteId', ${note.id}::text, 'seq', ${note.seq}::bigint), ${`stale-${note.id}`})`)
    const texts = await embeddedDuring(() => flushEmbeddings())
    expect(texts).toEqual([])
    expect(await noteBlockRows(note.id)).toEqual(newer)
  })

  it('an edit during the embed keeps the stale block set off the note; the newer job writes', async () => {
    const { note } = await makeNote(BODY)
    const embed = embedder.embed.bind(embedder)
    let edited = false
    vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
      const vectors = await embed(texts)
      if (!edited) {
        edited = true
        await db.update(notes).set({ body: BODY.replace('Beta text about bananas.', 'Beta text about blueberries.') }).where(eq(notes.id, note.id))
      }
      return vectors
    })
    await embedNow(note.id)
    expect(await noteBlockRows(note.id)).toEqual([])

    await embedNow(note.id)
    const rows = await noteBlockRows(note.id)
    expect(rows.map((b) => b.innerPath)).toEqual(['', 'Alpha', 'Alpha > Beta', 'Gamma'])
    expect(rows.every((b) => b.ownerVersion === rows[0]!.ownerVersion && b.ownerVersion !== String(note.seq))).toBe(true)
  })
})

describe('the note vector leg rolls blocks up to one hit per note (#452)', () => {
  it('a note whose every block matches is one hit, scored once per leg', async () => {
    const repeated = Array.from({ length: 6 }, (_, i) => `# Kiwi ${i}\nkiwi orchard kiwi harvest kiwi\n`).join('\n')
    const { vaultId, note } = await makeNote(repeated)
    const [other] = await db
      .insert(notes)
      .values({ vaultId, type: 'concepts', name: 'o', path: `concepts/o-${Date.now()}`, body: '# Pears\npear orchard\n', frontmatter: {} })
      .returning()
    await embedNow(note.id)
    await embedNow(other!.id)
    expect((await noteBlockRows(note.id)).length).toBe(6)

    const hits = (await searchNotes({ vaultIds: [vaultId], repositoryIds: [] }, 'kiwi orchard harvest', 10)).results
    expect(hits.filter((h) => h.id === note.id)).toHaveLength(1)
    expect(hits[0]!.id).toBe(note.id)
    // One contribution per leg at most (RRF k = 60): duplicates in the vector leg would add more.
    expect(hits[0]!.score).toBeLessThanOrEqual(2 / 61 + 1e-9)
  })
})
