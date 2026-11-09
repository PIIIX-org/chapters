// #415: one note can answer several aspects of a query, without scattering its passages or flooding the ranking.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { notes, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { renderNoteFile } from '../src/notes/projector.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

const QUERY = 'quokka rotation renewal gateway'
const intro = Array.from({ length: 12 }, (_, i) => `Plain introduction line ${i}.`).join('\n')
const section = (aspect: string) => `## ${aspect}\n\n${intro}\n\n${`quokka ${aspect.toLowerCase()} `.repeat(20)}\n`
let vaultId: string

beforeAll(async () => {
  const owner = await createActiveUser()
  const [vault] = await db.insert(vaults).values({ name: 'grouped-passages', ownerId: owner.id }).returning()
  vaultId = vault!.id
  await createNote(vaultId, {
    path: 'docs/handbook',
    body: ['Rotation', 'Renewal', 'Gateway', 'Recovery'].map(section).join('\n'),
  })
  await createNote(vaultId, {
    path: 'docs/reference',
    body: `## Reference\n\n${QUERY}\n\n${['Rotation', 'Renewal', 'Gateway'].map(section).join('\n')}`,
  })
  await flushEmbeddings()
}, 120_000)

afterEach(() => vi.restoreAllMocks())

const search = (limit = 20) => searchNotes({ vaultIds: [vaultId], repositoryIds: [] }, QUERY, limit, {}, { route: false })

describe('grouped note passages (#415)', () => {
  it('returns three distinct located passages, each with its own span, cost and snippet around its match', async () => {
    const answer = await search()
    const hits = answer.results.filter((hit) => hit.path === 'docs/handbook')
    expect(hits).toHaveLength(3)
    expect(new Set(hits.map((hit) => hit.block)).size).toBe(3)
    expect(new Set(hits.map((hit) => `${hit.startLine}-${hit.endLine}`)).size).toBe(3)
    const [note] = await db.select().from(notes).where(eq(notes.id, hits[0]!.id))
    const file = renderNoteFile({ frontmatter: note!.frontmatter, frontmatterSrc: null, body: note!.body }).split('\n')
    for (const hit of hits) {
      expect(hit.block).toMatch(/^b_[a-z2-7]{12}$/)
      const passage = file.slice(hit.startLine! - 1, hit.endLine).join('\n')
      expect(passage.startsWith(`## ${hit.heading}\n`)).toBe(true)
      expect(passage.match(/^## /gm)).toHaveLength(1)
      expect(hit.tokens).toBe(Math.ceil((passage.length + 1) / 4))
      expect(hit.snippet).toContain('<b>quokka</b>')
      expect(hit.snippet.toLowerCase()).toContain(`<b>${hit.heading!.toLowerCase()}</b>`)
    }
  })

  it('keeps each note adjacent, ranks documents by their best passage and passages best first, and caps every note at three', async () => {
    const { results } = await search()
    expect(new Set(results.map((hit) => hit.id)).size).toBe(2)
    // Both notes have a keyword-fused top passage ahead of the other note's vector-only passages.
    // Without grouping, those top passages split the first note's group.
    expect(results).toHaveLength(6)
    expect(results.slice(0, 3).every((hit) => hit.id === results[0]!.id)).toBe(true)
    expect(results[3]!.score).toBeGreaterThan(results[2]!.score)
    const seen = new Set<string>()
    let previousId: string | undefined
    let previousScore = Infinity
    let topScore = Infinity
    for (const hit of results) {
      if (hit.id !== previousId) {
        expect(seen.has(hit.id)).toBe(false)
        expect(hit.score).toBeLessThanOrEqual(topScore)
        topScore = hit.score
        previousScore = Infinity
        seen.add(hit.id)
      }
      expect(hit.score).toBeLessThanOrEqual(previousScore)
      previousScore = hit.score
      previousId = hit.id
      expect(results.filter((other) => other.id === hit.id).length).toBeLessThanOrEqual(3)
    }
    expect((await search(2)).results).toEqual(results.slice(0, 2))
  })

  it('merges the keyword hit into the best vector passage instead of returning that passage twice', async () => {
    const { results } = await search()
    const hits = results.filter((hit) => hit.path === 'docs/handbook')
    expect(hits[0]!.channel).toBe('both')
    expect(hits.slice(1).every((hit) => hit.channel === 'vector')).toBe(true)
    expect(new Set(hits.map((hit) => hit.block)).size).toBe(hits.length)
  })

  it('still returns one located passage per note when embeddings are unavailable', async () => {
    vi.spyOn(embedder, 'embed').mockRejectedValue(new Error('embedding unavailable'))
    const answer = await search()
    expect(answer.retrieval_mode).toBe('keyword_only')
    expect(answer.results).toHaveLength(2)
    expect(new Set(answer.results.map((hit) => hit.id)).size).toBe(2)
    for (const hit of answer.results) {
      expect(hit.startLine).toBeGreaterThan(0)
      expect(hit.endLine).toBeGreaterThanOrEqual(hit.startLine!)
      expect(hit.tokens).toBeGreaterThan(0)
      expect(hit.channel).toBe('keyword')
    }
  })
})
