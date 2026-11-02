// #414: a search hit points at a passage: `block`, `heading`, `startLine`-`endLine` (lines of the note's file or of the
// repository file, what `read_note` and `read_file` take), `tokens`, a snippet around the match and the `channel`
// that found it, instead of a document.
import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { notes, repositories, repositoryFiles, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { renderNoteFile } from '../src/notes/projector.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { bestPlace, LOCATE_HITS, LOCATE_MAX_CHARS, locateHits, matchTerms, SNIPPET_CHARS, snippetAround } from '../src/search/locate.js'
import { embedQuery } from '../src/search/embeddings.js'
import { lineStarts } from '../src/text/lines.js'
import { searchNotes, type SearchResult } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

let vaultId: string
let repoId: string

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Plain filler sentence ${i} about nothing in particular.`).join('\n')
const GUIDE = `# Guide\n\nIntro paragraph about the project.\n\n## Setup\n\n${filler(30)}\n\n## Rotating the zephyrkey credentials\n\nTo rotate the zephyrkey credentials, run the rotation job and then restart the gateway. The old zephyrkey stays valid for one hour.\n\n## Appendix\n\n${filler(10)}\n`

beforeAll(async () => {
  const user = await createActiveUser()
  const [v] = await db.insert(vaults).values({ name: 'located-vault', ownerId: user.id }).returning()
  vaultId = v!.id
  await createNote(vaultId, { path: 'docs/guide', body: GUIDE })
  const [r] = await db.insert(repositories).values({ name: 'located-repo', ownerId: user.id, ingestionMethod: 'agent_push' }).returning()
  repoId = r!.id
  const files = [
    {
      path: 'src/gateway.ts',
      content: [
        'export function startGateway(): void {',
        '  console.log("start")',
        '}',
        '',
        ...Array.from({ length: 20 }, (_, i) => `// unrelated comment ${i}`),
        'export function rotateQuokkaSecret(token: string): string {',
        '  const renewed = token + "-renewed"',
        '  return renewed',
        '}',
        '',
      ].join('\n'),
    },
  ]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
  await flushEmbeddings()
}, 120_000)

describe('a note hit points at its passage (#414)', () => {
  it('carries the section block, its heading path, the lines of the note file, the tokens and a snippet around the match', async () => {
    const res = await searchNotes({ vaultIds: [vaultId], repositoryIds: [] }, 'rotate zephyrkey credentials restart gateway', 10)
    const hit = res.results.find((r) => r.path === 'docs/guide')!
    expect(hit).toBeDefined()
    expect(hit.block).toMatch(/^b_[a-z2-7]{12}$/)
    expect(hit.heading).toContain('Rotating the zephyrkey credentials')
    // The lines are the ones `read_note` numbers: cut the file as rendered and the section is there, from its heading.
    const [row] = await db.select().from(notes).where(eq(notes.id, hit.id))
    const file = renderNoteFile({ frontmatter: row!.frontmatter, frontmatterSrc: null, body: row!.body }).split('\n')
    const passage = file.slice(hit.startLine! - 1, hit.endLine)
    expect(passage[0]).toMatch(/^## Rotating the zephyrkey credentials/)
    expect(passage.join('\n')).toContain('restart the gateway')
    expect(passage.join('\n')).not.toContain('## Appendix')
    // Characters of the span, over 4 (the line break that ends it counts).
    expect(Math.abs(hit.tokens! - Math.ceil((passage.join('\n').length + 1) / 4))).toBeLessThanOrEqual(1)
    expect(hit.tokens!).toBeLessThan(200)
    expect(hit.snippet.replace(/<\/?b>/g, '').length).toBeLessThanOrEqual(SNIPPET_CHARS)
    expect(hit.snippet.toLowerCase()).toContain('<b>zephyrkey</b>')
    expect(['keyword', 'vector', 'both']).toContain(hit.channel)
  })

  it('the channel names the legs that found it', async () => {
    const exact = await searchNotes({ vaultIds: [vaultId], repositoryIds: [] }, 'zephyrkey', 10)
    expect(exact.results.find((r) => r.path === 'docs/guide')!.channel).toMatch(/keyword|both/)
  })
})

describe('a code file hit points at the symbol around the match, a symbol hit is its own span (#414)', () => {
  it('names the function the match is in, with its block, lines and tokens', async () => {
    const res = await searchNotes({ vaultIds: [], repositoryIds: [repoId] }, 'rotateQuokkaSecret token renewed', 10, {}, { includeSymbols: true })
    const file = res.results.find((r) => r.resourceType === 'code' && r.path === 'src/gateway.ts')
    const symbol = res.results.find((r) => r.resourceType === 'symbol' && r.symbolName === 'rotateQuokkaSecret')
    expect(symbol).toBeDefined()
    expect(symbol!.block).toMatch(/^b_[a-z2-7]{12}$/)
    expect(symbol!.heading).toBe('rotateQuokkaSecret')
    expect(symbol!.tokens).toBeGreaterThan(5)
    expect(file).toBeDefined()
    // The file hit points at the same function, not at the file or at the first function.
    expect(file!.startLine).toBe(symbol!.startLine)
    expect(file!.endLine).toBe(symbol!.endLine)
    expect(file!.block).toBe(symbol!.block)
    expect(file!.snippet.replace(/<\/?b>/g, '').length).toBeLessThanOrEqual(SNIPPET_CHARS)
    expect(file!.snippet).toContain('<b>rotateQuokkaSecret</b>')
  })
})

describe('locating a match', () => {
  it('the query terms are its identifiers (and their parts) and its content words, not its filler', () => {
    expect(matchTerms('Where is the function parseConfig that reads the settings?')).toEqual(['function', 'parseconfig', 'parse', 'config', 'reads', 'settings'])
  })

  it('the best place is the line with the most distinct terms around it, not the first occurrence', () => {
    const text = ['alpha appears alone here', ...Array.from({ length: 20 }, () => 'nothing'), 'beta and', 'alpha and', 'gamma together'].join('\n')
    const place = bestPlace(text, lineStarts(text), ['alpha', 'beta', 'gamma'])!
    expect(place.line).toBeGreaterThan(20)
  })

  it('a snippet is cut around the match at word edges, at most 200 characters', () => {
    const text = `${'word '.repeat(100)}NEEDLE ${'tail '.repeat(100)}`
    const snippet = snippetAround(text, text.indexOf('NEEDLE'))
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS)
    expect(snippet).toContain('NEEDLE')
    expect(snippet.startsWith('ord ')).toBe(false)
    expect(snippetAround(text, text.indexOf('NEEDLE'), ['needle'])).toContain('<b>NEEDLE</b>')
    // Whole words only, as ts_headline marks them.
    expect(snippetAround('SCOPEMARK scope probe', 0, ['scope'])).toBe('SCOPEMARK <b>scope</b> probe')
  })
})

describe('hits no term occurs in, big documents and many hits (#414 review)', () => {
  it('a code file no term occurs in points at the symbol nearest to the query vector', async () => {
    const [file] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.path, 'src/gateway.ts'))
    const hit: SearchResult = { resourceType: 'code', id: file!.id, containerId: repoId, path: file!.path, channel: 'vector', snippet: 'old', score: 1, updated: '2026-11-01' }
    const vec = JSON.stringify(await embedQuery('rotateQuokkaSecret token renewed', null))
    await locateHits([hit], 'zzqqx wwvvk', new Map(), vec)
    expect(hit.heading).toBe('rotateQuokkaSecret')
    expect(hit.block).toMatch(/^b_[a-z2-7]{12}$/)
    expect(hit.startLine).toBe(25)
    expect(hit.tokens).toBeGreaterThan(5)
    // Without a vector there is nothing to point at: the hit stays a file hit.
    const bare: SearchResult = { ...hit, startLine: undefined, endLine: undefined, block: undefined, heading: undefined, tokens: undefined, snippet: 'old' }
    await locateHits([bare], 'zzqqx wwvvk', new Map())
    expect(bare.startLine).toBeUndefined()
    expect(bare.snippet).toBe('old')
  })

  it('a note over the read limit still points at the block its vector leg found, without tokens or a new snippet', async () => {
    const big = `# Big\n\n${'filler line that goes on and on and on\n'.repeat(Math.ceil(LOCATE_MAX_CHARS / 38) + 10)}\n## Tail\n\nthe zephyrkey rotation section\n`
    const row = await createNote(vaultId, { path: 'docs/big', body: big })
    await flushExtraction()
    await flushEmbeddings()
    const res = await searchNotes({ vaultIds: [vaultId], repositoryIds: [] }, 'zephyrkey rotation section', 10)
    const hit = res.results.find((r) => r.path === 'docs/big')
    expect(hit).toBeDefined()
    if (hit!.channel !== 'keyword') {
      expect(hit!.block).toMatch(/^b_[a-z2-7]{12}$/)
      expect(hit!.startLine).toBeGreaterThan(1)
    }
    expect(hit!.tokens).toBeUndefined()
    expect(row.id).toBe(hit!.id)
  })

  it('only the first LOCATE_HITS hits are located', async () => {
    const [row] = await db.select().from(notes).where(eq(notes.path, 'docs/guide'))
    const many: SearchResult[] = Array.from({ length: LOCATE_HITS + 5 }, () => ({ resourceType: 'note', id: row!.id, containerId: vaultId, path: 'docs/guide', channel: 'keyword', snippet: 'old', score: 1, updated: '2026-11-01' }))
    await locateHits(many, 'zephyrkey', new Map())
    expect(many.filter((h) => h.block !== undefined)).toHaveLength(LOCATE_HITS)
    expect(many.at(-1)!.snippet).toBe('old')
  })

  it('finds the place with the most distinct terms in one pass, however many occurrences there are', () => {
    const noise = Array.from({ length: 3000 }, () => 'alpha alpha alpha alpha').join('\n')
    const text = `${noise}\n\n\n\n\n\n\n\n\n\n\n\n\n\n\nbeta here\ngamma there and alpha too\n`
    const place = bestPlace(text, lineStarts(text), ['alpha', 'beta', 'gamma'])!
    expect(place.line).toBeGreaterThan(3000)
    // Characters whose lower case is longer shift every index: no place at all.
    expect(bestPlace('İstanbul alpha', lineStarts('İstanbul alpha'), ['alpha'])).toBeNull()
  })

  it('acronyms of three capitals are terms, and a snippet keeps its first word when the text breaks there', () => {
    expect(matchTerms('how does the API handle RAG')).toEqual(['api', 'handle', 'rag'])
    expect(snippetAround('word '.repeat(5) + 'NEEDLE ' + 'tail '.repeat(100), 25)).toMatch(/^(word |NEEDLE)/)
  })
})
