// #441, #442, #458 (ADR-004 §2.3): `search` and `find_symbols` answer with
// `{status, retrieval_mode, degraded, index?, results}` over MCP and REST
// (MCP adds the budget's `truncated`). A hit counts only when the keyword
// channel matched it or its vector distance is under the relevance gate, so
// an unrelated query says `no_match` instead of listing the nearest rows; an
// empty answer says whether the scope is still being indexed
// (`index_building`) or cannot be searched (`unavailable`); a failed query
// embedding falls back to the keyword channel (`keyword_only`, `degraded`).
// Results are in one total order: score, then path by code unit, then id.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { jobs, repositoryFiles } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
interface Hit {
  resourceType?: string
  id: string
  path: string
  name?: string
  snippet?: string | null
  score: number
}
interface Envelope {
  status: 'ok' | 'no_match' | 'index_building' | 'unavailable'
  retrieval_mode: 'hybrid' | 'keyword_only' | 'vector_only'
  degraded: false | { reason: string }
  index?: { pending_notes: number; pending_files: number; failed: number }
  results: Hit[]
  truncated?: false | { cursor: string | null; shown: Record<string, number>; total: Record<string, number | string> }
}

let app: FastifyInstance
let baseUrl: string
let cookie: string
let agent: Client
/** Notes about fruit and stone, plus two notes that tie. */
let vaultId: string
/** One note and one code file that score the same (each alone in its leg). */
let tieVaultId: string
let tieRepoId: string
/** Symbols to find. */
let repoId: string
/** A file still waiting for extraction. */
let buildingRepoId: string
/** Its only file's extraction failed. */
let failedRepoId: string
const clients: Client[] = []

async function rest(url: string): Promise<Envelope> {
  const res = await app.inject({ method: 'GET', url, headers: { cookie } })
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
  return res.json<Envelope>()
}

async function mcp(tool: string, args: Args): Promise<Envelope> {
  resetRateLimits()
  const result = await agent.callTool({ name: tool, arguments: args })
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
  expect(result.isError, text.slice(0, 300)).not.toBe(true)
  const json = JSON.parse(text) as Envelope
  expect(Object.keys(json).at(-1)).toBe('truncated')
  return json
}

/** The REST answer and the MCP answer of one vault search, which carry the same envelope. */
async function bothVault(q: string, vault = vaultId): Promise<Envelope[]> {
  return [await rest(`/api/vaults/${vault}/search?q=${encodeURIComponent(q)}`), await mcp('search', { vaultId: vault, query: q })]
}

const dialect = new PgDialect()
/** Makes `db.execute` fail for the statements `match` picks (by their SQL text); others run. */
function failStatements(match: (text: string) => boolean) {
  const execute = db.execute.bind(db)
  return vi.spyOn(db, 'execute').mockImplementation(((query: SQL) => {
    const text = dialect.sqlToQuery(query).sql
    if (match(text)) return Promise.reject(new Error('injected leg failure'))
    return execute(query)
  }) as typeof db.execute)
}
const vectorLeg = (text: string) => text.includes('<=>')
const keywordLeg = (text: string) => text.includes('websearch_to_tsquery') || text.includes('ILIKE')

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  const post = async (url: string, body: Args) => (await app.inject({ method: 'POST', url, headers: { cookie }, body })).json<{ id: string; token: string }>()
  vaultId = (await post('/api/vaults', { name: 'search envelope' })).id
  tieVaultId = (await post('/api/vaults', { name: 'search envelope ties' })).id
  repoId = (await post('/api/repositories', { name: 'envelope-symbols', ingestionMethod: 'agent_push' })).id
  tieRepoId = (await post('/api/repositories', { name: 'envelope-ties', ingestionMethod: 'agent_push' })).id
  buildingRepoId = (await post('/api/repositories', { name: 'envelope-building', ingestionMethod: 'agent_push' })).id
  failedRepoId = (await post('/api/repositories', { name: 'envelope-failed', ingestionMethod: 'agent_push' })).id
  const { token } = await post('/api/mcp-connections', { name: 'search-envelope', scope: 'account' })
  agent = new Client({ name: 'search-envelope-test', version: '0.0.0' })
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(agent)

  // Bodies of one repeated word: the test embedder's vector of a note is then that word's dimension, far
  // from any query that does not contain it, whatever the path and frontmatter tokens add.
  await createNote(vaultId, { path: 'fruit/apple', body: 'apple '.repeat(40) })
  await createNote(vaultId, { path: 'fruit/pear', body: 'pear '.repeat(40) })
  await createNote(vaultId, { path: 'geology/granite', body: 'granite '.repeat(40) })
  // Inserted in the reverse of path order: with equal keyword rank only the tie-break orders them.
  await createNote(vaultId, { path: 'tie/zulu', body: 'tiebreak '.repeat(40) })
  await createNote(vaultId, { path: 'tie/alpha', body: 'tiebreak '.repeat(40) })
  // A note and a file, each alone in its legs, so both are rank 1 twice: equal scores. 'Z' (90) sorts before 'a' (97).
  await createNote(tieVaultId, { path: 'alpha/zeta', body: 'orbitalthruster '.repeat(40) })
  await syncRepositoryFiles(tieRepoId, [{ path: 'Zeta.ts', content: 'orbitalthruster '.repeat(40) }], ['Zeta.ts'])
  const symbols = Array.from({ length: 30 }, (_, i) => `export function quasarHandler${i}(input: string) {\n  return input + '${i}'\n}`).join('\n')
  await syncRepositoryFiles(repoId, [{ path: 'src/quasar.ts', content: symbols }], ['src/quasar.ts'])
  await flushExtraction()
  await flushEmbeddings()

  // A file written before its extraction job (no job, no embedding): still to be indexed.
  const content = 'export const building = 1'
  const hash = createHash('sha256').update(content).digest('hex')
  await db.insert(repositoryFiles).values({ repositoryId: buildingRepoId, path: 'src/building.ts', content, contentHash: hash, size: content.length })
  // A file whose extraction for its current content gave up.
  const [failed] = await db
    .insert(repositoryFiles)
    .values({ repositoryId: failedRepoId, path: 'src/failed.ts', content, contentHash: hash, size: content.length })
    .returning()
  await db.insert(jobs).values({
    kind: 'extract',
    payload: { fileId: failed!.id, repositoryId: failedRepoId },
    idempotencyKey: `extract:${failed!.id}:${hash}`,
    attempts: 3,
    lastError: 'Error: parser blew up',
    doneAt: new Date(),
  })
}, 180_000)

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('status ok: the envelope around matching hits (#442, #458)', () => {
  it('a keyword hit answers ok, hybrid, not degraded, with no index block when nothing is pending', async () => {
    for (const answer of await bothVault('apple')) {
      expect(answer.status).toBe('ok')
      expect(answer.retrieval_mode).toBe('hybrid')
      expect(answer.degraded).toBe(false)
      expect(answer).not.toHaveProperty('index')
      expect(answer.results[0]?.path).toBe('fruit/apple')
    }
  })

  it('the account-wide REST search and the repository REST search answer the same envelope', async () => {
    const everywhere = await rest('/api/search?q=apple')
    expect(everywhere.status).toBe('ok')
    expect(everywhere.results.some((h) => h.path === 'fruit/apple')).toBe(true)
    const repo = await rest(`/api/repositories/${repoId}/search?q=quasarHandler7`)
    expect(repo.status).toBe('ok')
    expect(repo.retrieval_mode).toBe('hybrid')
  })
})

describe('relevance gate (#441)', () => {
  it('an unrelated query answers no_match with no results instead of the nearest rows', async () => {
    for (const answer of await bothVault('zzyxxsecretmarker qqvortexium')) {
      expect(answer.results).toEqual([])
      expect(answer.status).toBe('no_match')
      expect(answer.retrieval_mode).toBe('hybrid')
      expect(answer.degraded).toBe(false)
    }
  })

  it('a hit only the vector channel finds still passes when it is close', async () => {
    // "apple banana": the keyword channel needs both words (no note has banana); the vector of fruit/apple is close.
    for (const answer of await bothVault('apple banana')) {
      expect(answer.status).toBe('ok')
      expect(answer.results.map((h) => h.path)).toEqual(['fruit/apple'])
    }
  })

  it('find_symbols answers no_match for an unrelated query, over MCP and REST', async () => {
    const viaMcp = await mcp('find_symbols', { repositoryId: repoId, query: 'zzyxxsecretmarker qqvortexium' })
    const viaRest = await rest(`/api/repositories/${repoId}/symbols/search?q=${encodeURIComponent('zzyxxsecretmarker qqvortexium')}`)
    for (const answer of [viaMcp, viaRest]) {
      expect(answer.results).toEqual([])
      expect(answer.status).toBe('no_match')
      expect(answer.retrieval_mode).toBe('hybrid')
      expect(answer.degraded).toBe(false)
    }
    const found = await mcp('find_symbols', { repositoryId: repoId, query: 'quasarHandler7' })
    expect(found.status).toBe('ok')
    expect(found.results[0]?.name).toBe('quasarHandler7')
  })
})

describe('index_building and unavailable (#442)', () => {
  it('nothing matched while a file of the scope waits for extraction: index_building with the pending count', async () => {
    const viaMcp = await mcp('search', { repositoryId: buildingRepoId, query: 'zzyxxsecretmarker' })
    const viaRest = await rest(`/api/repositories/${buildingRepoId}/search?q=zzyxxsecretmarker`)
    for (const answer of [viaMcp, viaRest]) {
      expect(answer.results).toEqual([])
      expect(answer.status).toBe('index_building')
      expect(answer.index).toEqual({ pending_notes: 0, pending_files: 1, failed: 0 })
    }
    const symbols = await mcp('find_symbols', { repositoryId: buildingRepoId, query: 'zzyxxsecretmarker' })
    expect(symbols.status).toBe('index_building')
    expect(symbols.index).toEqual({ pending_notes: 0, pending_files: 1, failed: 0 })
  })

  it('a match while indexing is still going on is ok, with the index block shown', async () => {
    const answer = await mcp('search', { repositoryId: buildingRepoId, query: 'building' })
    expect(answer.status).toBe('ok')
    expect(answer.results.map((h) => h.path)).toEqual(['src/building.ts'])
    expect(answer.index).toEqual({ pending_notes: 0, pending_files: 1, failed: 0 })
  })

  it('a note without its embedding counts as pending', async () => {
    const note = await createNote(vaultId, { path: 'pending/note', body: 'pending '.repeat(10) })
    await flushEmbeddings()
    await db.execute(sql`UPDATE notes SET embedding = NULL WHERE id = ${note.id}`)
    await db.execute(sql`DELETE FROM jobs WHERE idempotency_key LIKE ${`embed_note:${note.id}:%`}`)
    try {
      for (const answer of await bothVault('zzyxxsecretmarker')) {
        expect(answer.status).toBe('index_building')
        expect(answer.index).toEqual({ pending_notes: 1, pending_files: 0, failed: 0 })
      }
    } finally {
      await db.execute(sql`DELETE FROM notes WHERE id = ${note.id}`)
    }
  })

  it('every item of the scope failed indexing: unavailable, with the failure counted', async () => {
    const viaMcp = await mcp('search', { repositoryId: failedRepoId, query: 'zzyxxsecretmarker' })
    const viaRest = await rest(`/api/repositories/${failedRepoId}/search?q=zzyxxsecretmarker`)
    for (const answer of [viaMcp, viaRest]) {
      expect(answer.results).toEqual([])
      expect(answer.status).toBe('unavailable')
      expect(answer.index).toEqual({ pending_notes: 0, pending_files: 0, failed: 1 })
    }
  })

  it('no retrieval channel could run (embedder down, keyword query failing): unavailable, not no_match', async () => {
    vi.spyOn(embedder, 'embed').mockRejectedValue(new Error('injected embedder failure'))
    failStatements(keywordLeg)
    for (const answer of await bothVault('apple')) {
      expect(answer.results).toEqual([])
      expect(answer.status).toBe('unavailable')
      expect(answer.degraded).toEqual({ reason: 'embedder_failed' })
    }
  })
})

describe('degraded: keyword-only fallback (#458)', () => {
  it('a failed query embedding answers the keyword hits, keyword_only and degraded', async () => {
    const embed = vi.spyOn(embedder, 'embed').mockRejectedValue(new Error('injected embedder failure'))
    for (const answer of await bothVault('apple')) {
      expect(answer.status).toBe('ok')
      expect(answer.retrieval_mode).toBe('keyword_only')
      expect(answer.degraded).toEqual({ reason: 'embedder_failed' })
      expect(answer.results.map((h) => h.path)).toEqual(['fruit/apple'])
    }
    const symbols = await mcp('find_symbols', { repositoryId: repoId, query: 'quasarHandler7' })
    expect(symbols.retrieval_mode).toBe('keyword_only')
    expect(symbols.degraded).toEqual({ reason: 'embedder_failed' })
    expect(symbols.status).toBe('ok')
    expect(embed).toHaveBeenCalled()
  })

  it('a failed vector query answers keyword_only, degraded by the vector leg', async () => {
    failStatements(vectorLeg)
    for (const answer of await bothVault('apple')) {
      expect(answer.status).toBe('ok')
      expect(answer.retrieval_mode).toBe('keyword_only')
      expect(answer.degraded).toEqual({ reason: 'vector_leg_failed' })
      expect(answer.results.map((h) => h.path)).toEqual(['fruit/apple'])
    }
  })

  it('a failed keyword query answers vector_only, degraded by the keyword leg', async () => {
    failStatements(keywordLeg)
    for (const answer of await bothVault('apple')) {
      expect(answer.status).toBe('ok')
      expect(answer.retrieval_mode).toBe('vector_only')
      expect(answer.degraded).toEqual({ reason: 'keyword_leg_failed' })
      expect(answer.results[0]?.path).toBe('fruit/apple')
    }
  })

  it('degraded with nothing matching is still no_match', async () => {
    vi.spyOn(embedder, 'embed').mockRejectedValue(new Error('injected embedder failure'))
    for (const answer of await bothVault('zzyxxsecretmarker')) {
      expect(answer.status).toBe('no_match')
      expect(answer.degraded).toEqual({ reason: 'embedder_failed' })
    }
  })
})

describe('total order: score, then path by code unit, then id (#623 via ADR-004 §2.3)', () => {
  it('equal scores are ordered by path code units, in MCP and REST', async () => {
    const viaRest = await rest(`/api/search?q=orbitalthruster`)
    const viaMcp = await mcp('search', { everywhere: true, query: 'orbitalthruster' })
    for (const answer of [viaRest, viaMcp]) {
      const tied = answer.results.filter((h) => h.path === 'Zeta.ts' || h.path === 'alpha/zeta')
      expect(tied).toHaveLength(2)
      expect(tied[0]!.score).toBe(tied[1]!.score)
      expect(tied.map((h) => h.path)).toEqual(['Zeta.ts', 'alpha/zeta'])
    }
  })

  it('equal keyword ranks inside a leg are cut by path, so the ranking does not depend on row order', async () => {
    vi.spyOn(embedder, 'embed').mockRejectedValue(new Error('injected embedder failure'))
    for (const answer of await bothVault('tiebreak')) {
      expect(answer.results.map((h) => h.path)).toEqual(['tie/alpha', 'tie/zulu'])
    }
  })
})

describe('MCP search joins the budget envelope (#420, #422)', () => {
  it('a small answer is whole: truncated false', async () => {
    const answer = await mcp('search', { vaultId, query: 'apple' })
    expect(answer.truncated).toBe(false)
  })

  it('budget_tokens pages the ranking with a cursor; every hit shows once', async () => {
    const pages: Envelope[] = []
    let cursor: string | null = null
    do {
      const answer = await mcp('find_symbols', { repositoryId: repoId, query: 'quasarHandler', budget_tokens: 256, ...(cursor ? { cursor } : {}) })
      pages.push(answer)
      cursor = answer.truncated === false || answer.truncated === undefined ? null : answer.truncated.cursor
    } while (cursor && pages.length < 50)
    expect(pages.length).toBeGreaterThan(1)

    const searchPages: Envelope[] = []
    cursor = null
    do {
      const answer = await mcp('search', { repositoryId: repoId, query: 'quasarHandler', symbols: true, budget_tokens: 256, ...(cursor ? { cursor } : {}) })
      expect(Math.ceil(JSON.stringify(answer).length / 4)).toBeLessThanOrEqual(256)
      expect(answer.status).toBe('ok')
      searchPages.push(answer)
      cursor = answer.truncated === false || answer.truncated === undefined ? null : answer.truncated.cursor
    } while (cursor && searchPages.length < 50)
    expect(searchPages.length).toBeGreaterThan(1)
    const shown = searchPages.flatMap((p) => p.results.map((h) => (typeof h === 'string' ? h : `${h.resourceType}:${h.id}`)))
    expect(new Set(shown).size).toBe(shown.length)
  })
})
