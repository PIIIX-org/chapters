// #421 (ADR-004 §2.1): over budget, a budgeted tool first drops whole
// low-ranked items; when even a page of its own would show fewer than
// min(5, items left) of a list, every list on the page steps down one level
// of the ladder: full → no_context → locations → counts → total.
// `truncated.level` reports the level, `narrow` how to get the detail back,
// and nothing is left out without `truncated` counting it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
const LEVELS = ['full', 'no_context', 'locations', 'counts', 'total']
type Truncated =
  | false
  | {
      shown: Record<string, number>
      total: Record<string, number | string>
      dropped: Record<string, number>
      level: string
      cursor: string | null
      narrow: string[]
    }
type Answer = Record<string, unknown> & { truncated: Truncated }

let app: FastifyInstance
let baseUrl: string
let repoId: string
/** 30 notes under two long folder names: their paths do not fit 5 to a 256-token page. */
let longPathsVault: string
/** 30 notes, each in its own long-named folder: not even the per-folder counts fit 256 tokens. */
let manyFoldersVault: string
/** A chain of 10 linked notes. */
let graphVault: string
let agent: Client

const pad = (tag: string) => `${tag}-${'x'.repeat(140)}`
/** 30 functions of 25 lines: each symbol's snippet is ~1,200 characters, larger than a 256-token page. */
const ladderFile = Array.from(
  { length: 30 },
  (_, i) =>
    `export function ladderStep${i}(input: string) {\n${Array.from({ length: 23 }, (_, l) => `  const v${l} = input + '${'y'.repeat(30)}${l}'`).join('\n')}\n}`,
).join('\n')

async function call(tool: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name: tool, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

/**
 * One answer, checked against the envelope's invariants at every level: within
 * budget, `truncated` last, a ladder level, shown + dropped = total, and at
 * `counts`/`total` no item shown, everything dropped and no cursor.
 */
async function page(tool: string, args: Args): Promise<Answer> {
  const r = await call(tool, args)
  expect(r.isError, `${tool}: ${r.text.slice(0, 300)}`).toBe(false)
  const budget = typeof args.budget_tokens === 'number' ? args.budget_tokens : 2_000
  expect(Math.ceil(r.text.length / 4), `${tool} answer of ${r.text.length} chars over ${budget} tokens`).toBeLessThanOrEqual(budget)
  const json = JSON.parse(r.text) as Answer
  expect(Object.keys(json).at(-1)).toBe('truncated')
  const t = json.truncated
  if (t === false) return json
  expect(LEVELS).toContain(t.level)
  for (const [name, shown] of Object.entries(t.shown)) {
    const total = t.total[name]
    if (typeof total === 'number') expect(shown + t.dropped[name]!, `${tool} ${name}: shown + dropped = total`).toBe(total)
    else expect(total).toMatch(/^>\d+$/)
    const value = json[name]
    if (Array.isArray(value)) expect(value, `${tool} ${name}: one entry per item shown`).toHaveLength(shown)
  }
  if (t.level === 'counts' || t.level === 'total') expect(t.cursor).toBeNull()
  // Never truncated for nothing: a further page, a dropped item, or items shown below full.
  expect(t.cursor !== null || Object.values(t.dropped).some((n) => n > 0) || t.level !== 'full').toBe(true)
  return json
}

async function walk(tool: string, args: Args): Promise<Answer[]> {
  const pages: Answer[] = []
  let cursor: string | null = null
  for (;;) {
    const json = await page(tool, { ...args, ...(cursor ? { cursor } : {}) })
    pages.push(json)
    cursor = json.truncated === false ? null : json.truncated.cursor
    if (cursor === null) return pages
    if (pages.length > 200) throw new Error(`${tool} never reached the last page`)
  }
}

const levelOf = (json: Answer) => (json.truncated === false ? 'full' : json.truncated.level)
const truncatedOf = (json: Answer) => {
  if (json.truncated === false) throw new Error(`nothing truncated in ${JSON.stringify(json).slice(0, 300)}`)
  return json.truncated
}
/** The `budget_tokens: N` hint `narrow` starts with below `full`. */
const budgetHint = (json: Answer): number => {
  const hint = truncatedOf(json).narrow[0] ?? ''
  expect(hint).toMatch(/^budget_tokens: \d+$/)
  return Number(hint.slice('budget_tokens: '.length))
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  const vault = async (name: string) => (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name } })).json<{ id: string }>().id
  longPathsVault = await vault('ladder long paths')
  manyFoldersVault = await vault('ladder many folders')
  graphVault = await vault('ladder graph')
  repoId = (
    await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'ladder-repo', ingestionMethod: 'agent_push' } })
  ).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'ladder-agent', scope: 'account' } })
  agent = new Client({ name: 'budget-ladder-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )

  for (let i = 0; i < 30; i++) {
    await createNote(longPathsVault, { path: `${i % 2 ? 'beta' : 'alpha'}/${pad(`note-${String(i).padStart(2, '0')}`)}`, body: `Note ${i}.` })
    await createNote(manyFoldersVault, { path: `${pad(`folder-${String(i).padStart(2, '0')}`)}/note`, body: `Note ${i}.` })
  }
  const words = ['apple', 'river', 'stone', 'cloud', 'maple', 'ember', 'frost', 'tiger', 'violet', 'quartz']
  for (let i = 0; i < 10; i++) {
    // 40 repeats keep every pair far under SEMANTIC_THRESHOLD (as in mcp-response-envelope.test.ts): no shortcut edge.
    await createNote(graphVault, { path: `c${i}/link`, body: `${`${words[i]} `.repeat(40)}${i < 9 ? `[[c${i + 1}/link]]` : ''}` })
  }
  const files = [{ path: 'src/ladder.ts', content: ladderFile }]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
}, 180_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await app.close()
})

describe('find_symbols steps down when whole hits leave too little', () => {
  const query = { repositoryId: repoId, query: 'ladderStep', limit: 30 }

  it('a generous budget keeps full hits with snippets', async () => {
    const json = await page('find_symbols', { ...query, repositoryId: repoId, budget_tokens: 25_000 })
    expect(levelOf(json)).toBe('full')
    const results = json.results as Array<{ snippet: string }>
    expect(results).toHaveLength(30)
    expect(results.every((r) => r.snippet.length > 1_000)).toBe(true)
  })

  it('no_context: whole hits would show fewer than 5, so every hit drops its snippet; narrow names the budget for full', async () => {
    const json = await page('find_symbols', { ...query, repositoryId: repoId, budget_tokens: 700 })
    const t = truncatedOf(json)
    expect(t.level).toBe('no_context')
    const results = json.results as Array<Record<string, unknown>>
    expect(results.length).toBeGreaterThanOrEqual(5)
    for (const r of results) {
      expect(r).not.toHaveProperty('snippet')
      expect(r).toMatchObject({ path: 'src/ladder.ts', name: expect.stringMatching(/^ladderStep\d+$/), startLine: expect.any(Number) })
    }
    expect(t.dropped.results).toBe(30 - results.length)
    expect(t.cursor).toEqual(expect.any(String))

    const hinted = await page('find_symbols', { ...query, repositoryId: repoId, budget_tokens: budgetHint(json) })
    expect(levelOf(hinted)).toBe('full')
    expect((hinted.results as Array<{ snippet: string }>).length).toBeGreaterThanOrEqual(5)
    expect((hinted.results as Array<{ snippet: string }>).every((r) => r.snippet.length > 1_000)).toBe(true)
  })

  it('locations: at 256 tokens hits are `path#La-Lb`; paging lists every hit once, in ranking order', async () => {
    const full = await page('find_symbols', { ...query, repositoryId: repoId, budget_tokens: 25_000 })
    const ranking = (full.results as Array<{ startLine: number; endLine: number }>).map((r) => `src/ladder.ts#L${r.startLine}-L${r.endLine}`)
    expect(new Set(ranking)).toEqual(new Set(Array.from({ length: 30 }, (_, i) => `src/ladder.ts#L${i * 25 + 1}-L${i * 25 + 25}`)))

    const pages = await walk('find_symbols', { ...query, repositoryId: repoId, budget_tokens: 256 })
    expect(pages.length).toBeGreaterThan(1)
    for (const p of pages.slice(0, -1)) expect(levelOf(p)).toBe('locations')
    // The last page, with fewer hits left, may fit them at a higher level.
    const shown = pages.flatMap((p) =>
      (p.results as Array<string | { startLine: number; endLine: number }>).map((r) => (typeof r === 'string' ? r : `src/ladder.ts#L${r.startLine}-L${r.endLine}`)),
    )
    expect(shown).toEqual(ranking)
  })

  it('one hit larger than the whole budget steps down instead of breaking the budget', async () => {
    const json = await page('find_symbols', { ...query, repositoryId: repoId, limit: 1, budget_tokens: 256 })
    expect(levelOf(json)).toBe('no_context')
    expect(json.results).toEqual([expect.not.objectContaining({ snippet: expect.anything() })])
    expect(truncatedOf(json)).toMatchObject({ shown: { results: 1 }, total: { results: '>1' }, dropped: { results: 0 } })
  })
})

describe('browse_vault steps down to counts, then to the total', () => {
  it('locations: paths only, as long as 5 of them fit', async () => {
    const json = await page('browse_vault', { vaultId: longPathsVault, budget_tokens: 500 })
    expect(truncatedOf(json).level).toBe('locations')
    const notes = json.notes as string[]
    expect(notes.length).toBeGreaterThanOrEqual(5)
    expect(notes[0]).toBe(`alpha/${pad('note-00')}`)
  })

  it('counts: fewer than 5 paths fit, so the notes are counted per folder; no cursor, everything counted as dropped', async () => {
    const json = await page('browse_vault', { vaultId: longPathsVault, budget_tokens: 256 })
    const t = truncatedOf(json)
    expect(t.level).toBe('counts')
    expect(json.notes).toEqual({ alpha: 15, beta: 15 })
    expect(t).toMatchObject({ shown: { notes: 0 }, total: { notes: 30 }, dropped: { notes: 30 }, cursor: null })
    expect(t.narrow).toEqual(expect.arrayContaining(['path: "alpha"', 'path: "beta"']))
    budgetHint(json)
  })

  it('total: when not even the counts per folder fit, the answer is the number', async () => {
    const json = await page('browse_vault', { vaultId: manyFoldersVault, budget_tokens: 256 })
    const t = truncatedOf(json)
    expect(t.level).toBe('total')
    expect(json.notes).toBe(30)
    expect(t).toMatchObject({ shown: { notes: 0 }, total: { notes: 30 }, dropped: { notes: 30 }, cursor: null })
  })

  it('the directory view steps down every list; its index text, after them, is left out and counted', async () => {
    const json = await page('browse_vault', { vaultId: longPathsVault, path: 'alpha', budget_tokens: 256 })
    const t = truncatedOf(json)
    expect(t.level).toBe('counts')
    expect(json).toMatchObject({ directory: 'alpha', subdirectories: {}, notes: { alpha: 15 }, indexContent: '' })
    expect(t.shown.indexContent).toBe(0)
    expect(t.dropped.indexContent).toBeGreaterThan(0)
  })
})

describe('a budget sweep steps down in order', () => {
  it('from 25,000 down to 256 tokens the level never rises, and every answer keeps the envelope invariants', async () => {
    const budgets = [25_000, 8_000, 4_000, 2_000, 1_500, 1_000, 700, 500, 400, 300, 256]
    const calls: Array<[string, Args]> = [
      ['find_symbols', { repositoryId: repoId, query: 'ladderStep', limit: 30 }],
      ['browse_vault', { vaultId: longPathsVault }],
      ['browse_vault', { vaultId: manyFoldersVault }],
      ['graph', { vaultId: graphVault }],
    ]
    for (const [tool, args] of calls) {
      const levels: string[] = []
      for (const budget_tokens of budgets) levels.push(levelOf(await page(tool, { ...args, budget_tokens })))
      const ranks = levels.map((l) => LEVELS.indexOf(l))
      expect(ranks, `${tool} ${JSON.stringify(levels)}`).toEqual([...ranks].sort((a, b) => a - b))
      expect(levels[0], tool).toBe('full')
      expect(levels.at(-1), tool).not.toBe('full')
    }
  })
})

describe('graph and reads', () => {
  it('graph: a 256-token page steps below full; paging still shows every node and edge once', async () => {
    const all = await page('graph', { vaultId: graphVault, budget_tokens: 25_000 })
    expect(levelOf(all)).toBe('full')
    const nodeIds = (all.nodes as Array<{ id: string }>).map((n) => n.id).sort()
    const pages = await walk('graph', { vaultId: graphVault, budget_tokens: 256 })
    expect(pages.some((p) => levelOf(p) === 'no_context' || levelOf(p) === 'locations')).toBe(true)
    for (const p of pages) {
      for (const n of p.nodes as Array<Record<string, unknown>>) {
        expect(n).toMatchObject({ id: expect.any(String), path: expect.any(String) })
        expect(n).not.toHaveProperty('tags')
      }
    }
    expect(pages.flatMap((p) => (p.nodes as Array<{ id: string }>).map((n) => n.id)).sort()).toEqual(nodeIds)
    const edges = (p: Answer) => (p.edges as Array<{ source: string; target: string }>).map((e) => `${e.source}>${e.target}`)
    expect(pages.flatMap(edges).sort()).toEqual(edges(all).sort())
  })

  it('a read is never laddered: text pages by lines at full', async () => {
    const pages = await walk('read_file', { repositoryId: repoId, path: 'src/ladder.ts', budget_tokens: 256 })
    expect(pages.length).toBeGreaterThan(5)
    expect(pages.map((p) => p.content).join('')).toBe(ladderFile)
    for (const p of pages) expect(levelOf(p)).toBe('full')
  })
})
