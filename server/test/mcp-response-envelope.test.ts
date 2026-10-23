// #420 + #422 (ADR-004 §2.1): every read, browse, graph and history tool
// takes `budget_tokens` (characters / 4, the benchmark's estimate; default
// 2,000 for lists, 4,000 for reads), drops whole items or whole lines to stay
// within it, and ends its answer with `truncated`: false, or what it showed,
// the total from the page start (">n" when the fetch of limit+1 found more),
// what it dropped, and a cursor that continues with the same arguments only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { mcpConnections, noteReads, noteRevisions, notes } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote, softDeleteNote, updateNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
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

/** Default budgets (#420): reads 4,000 tokens, every other budgeted tool 2,000. */
const DEFAULT_BUDGET: Record<string, number> = { read_note: 4_000, read_file: 4_000, get_revision: 4_000 }
/**
 * A budget that pages these fixtures' lists at `full`: at least 5 whole items
 * a page (#421), never all of them. Smaller budgets step down the ladder
 * (mcp-budget-ladder.test.ts).
 */
const LIST_PAGE = 700

let app: FastifyInstance
let baseUrl: string
let vaultId: string
let repoId: string
/** A small graph: a chain of 10 notes, each its own type (no structural edges), linked in order. */
let graphVaultId: string
let agent: Client
let agentConnectionId: string
const clients: Client[] = []

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'response-envelope-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

async function call(tool: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name: tool, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

/** One answer, checked against the envelope's invariants: within budget, `truncated` last and consistent. */
async function page(tool: string, args: Args): Promise<Answer> {
  const r = await call(tool, args)
  expect(r.isError, `${tool}: ${r.text.slice(0, 300)}`).toBe(false)
  const budget = typeof args.budget_tokens === 'number' ? args.budget_tokens : (DEFAULT_BUDGET[tool] ?? 2_000)
  expect(Math.ceil(r.text.length / 4), `${tool} answer of ${r.text.length} chars over ${budget} tokens`).toBeLessThanOrEqual(budget)
  const json = JSON.parse(r.text) as Answer
  expect(Object.keys(json).at(-1)).toBe('truncated')
  const t = json.truncated
  if (t !== false) {
    expect(t.level).toBe('full')
    for (const [name, shown] of Object.entries(t.shown)) {
      const total = t.total[name]
      if (typeof total === 'number') expect(shown + t.dropped[name]!, `${tool} ${name}: shown + dropped = total`).toBe(total)
      else expect(total).toMatch(/^>\d+$/)
    }
    expect(t.cursor !== null || Object.values(t.dropped).some((n) => n > 0)).toBe(true)
  }
  return json
}

/** Follows `truncated.cursor` to the end; every page passes `page`'s checks. */
async function walk(tool: string, args: Args): Promise<Answer[]> {
  const pages: Answer[] = []
  let cursor: string | null = null
  for (;;) {
    const json = await page(tool, { ...args, ...(cursor ? { cursor } : {}) })
    pages.push(json)
    cursor = json.truncated === false ? null : json.truncated.cursor
    if (cursor === null) return pages
    if (pages.length > 400) throw new Error(`${tool} never reached the last page`)
  }
}

const cursorOf = (json: Answer): string => {
  if (json.truncated === false || json.truncated.cursor === null) throw new Error(`no cursor in ${JSON.stringify(json).slice(0, 300)}`)
  return json.truncated.cursor
}

async function refused(tool: string, args: Args, why: RegExp): Promise<void> {
  const r = await call(tool, args)
  expect(r.isError, `${tool} ${JSON.stringify(args).slice(0, 200)}: ${r.text.slice(0, 200)}`).toBe(true)
  expect(r.text).toMatch(why)
}

const ids = (pages: Answer[], key: string, id: (item: Record<string, unknown>) => string = (x) => x.id as string) =>
  pages.flatMap((p) => ((p[key] as Array<Record<string, unknown>> | undefined) ?? []).map(id))

/** A graph edge row (#558) as `from -> to`, also in its one-line form down the ladder. */
const edge = (e: unknown) => {
  if (typeof e === 'string') return e.split(' ').slice(0, 3).join(' ')
  const row = e as { from: { path: string }; to: { path: string }; directed: boolean }
  return `${row.from.path} ${row.directed ? '->' : '--'} ${row.to.path}`
}

const HISTORY = 'docs/history'
const BIG = 'docs/big'
/** ~150 KB over 2,500 numbered lines, so even the largest budget pages it. */
const bigBody = (tag: string) => Array.from({ length: 2_500 }, (_, i) => `${tag} line ${i + 1} ${'lorem ipsum '.repeat(4)}`).join('\n') + '\n'
const bigFile = Array.from({ length: 3_000 }, (_, i) => `export const value${i} = ${i} // ${'x'.repeat(30)}`).join('\n')
const symbolFile = Array.from({ length: 30 }, (_, i) => `export function alphaHandler${i}(input: string) {\n  return input + '${i}'\n}`).join('\n')

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'envelope vault' } })).json<{ id: string }>().id
  graphVaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'envelope graph' } })).json<{ id: string }>().id
  repoId = (
    await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'envelope-repo', ingestionMethod: 'agent_push' } })
  ).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'envelope-agent', scope: 'account' } })
  agent = await mcpClient(minted.json<{ token: string }>().token)
  agentConnectionId = (await db.select({ id: mcpConnections.id }).from(mcpConnections).where(eq(mcpConnections.name, 'envelope-agent')))[0]!.id

  // 40 notes in docs/, 5 in docs/sub/, 12 in the trash; the chain in its own vault.
  for (let i = 0; i < 40; i++) await createNote(vaultId, { path: `docs/note-${String(i).padStart(2, '0')}`, body: `Note ${i}.` })
  for (let i = 0; i < 5; i++) await createNote(vaultId, { path: `docs/sub/inner-${i}`, body: `Inner ${i}.` })
  // No semantic shortcut, whatever the timing: tests run with SEMANTIC_THRESHOLD=0.2 (vitest.config.ts), and the
  // embedded text also holds the path and frontmatter, whose `timestamp` tokens two notes made in the same second
  // share. With 8 repeats of each note's word the test embedder put chain pairs at ~0.16, and a timestamp's shared
  // tokens could lift one over 0.2 (distance 3 instead of 9). Each word below hashes to its own dimension, and 40
  // repeats keep any pair under ~0.1 however many of the ~25 other tokens two notes share.
  const words = ['apple', 'river', 'stone', 'cloud', 'maple', 'ember', 'frost', 'tiger', 'violet', 'quartz']
  for (let i = 0; i < 10; i++) {
    await createNote(graphVaultId, { path: `c${i}/link`, body: `${`${words[i]} `.repeat(40)}${i < 9 ? `[[c${i + 1}/link]]` : ''}` })
  }
  for (let i = 0; i < 12; i++) {
    await createNote(vaultId, { path: `trash/gone-${i}`, body: `Gone ${i}.` })
    await softDeleteNote(vaultId, `trash/gone-${i}`)
  }
  await createNote(vaultId, { path: HISTORY, body: 'v0' })
  for (let i = 1; i <= 40; i++) await updateNote(vaultId, HISTORY, { body: `v${i}` })
  await createNote(vaultId, { path: BIG, body: bigBody('first') })
  await createNote(vaultId, { path: 'docs/small', body: 'A small note.\n' })

  const files = [
    { path: 'src/big.ts', content: bigFile },
    { path: 'src/alpha.ts', content: symbolFile },
    ...Array.from({ length: 30 }, (_, i) => ({ path: `src/mod-${String(i).padStart(2, '0')}.ts`, content: `export const m${i} = ${i}` })),
  ]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
}, 180_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('note_history: hasMore/nextCursor moved into truncated', () => {
  it('a page cut by `limit` reports the total as ">limit" from the limit+1 fetch, with a cursor', async () => {
    const json = await page('note_history', { vaultId, path: HISTORY, limit: 5 })
    expect(json).not.toHaveProperty('hasMore')
    expect(json).not.toHaveProperty('nextCursor')
    expect(json.revisions).toHaveLength(5)
    expect(json.truncated).toMatchObject({ shown: { revisions: 5 }, total: { revisions: '>5' }, dropped: { revisions: 0 }, cursor: expect.any(String) })
  })

  it('a small budget drops whole revisions; paging returns every revision once, in order', async () => {
    const pages = await walk('note_history', { vaultId, path: HISTORY, limit: 100, budget_tokens: LIST_PAGE })
    expect(pages.length).toBeGreaterThan(2)
    expect(pages.some((p) => p.truncated !== false && p.truncated.dropped.revisions! > 0)).toBe(true)
    const all = await page('note_history', { vaultId, path: HISTORY, limit: 100, budget_tokens: 25_000 })
    expect(all.truncated).toBe(false)
    expect(ids(pages, 'revisions')).toEqual(ids([all], 'revisions'))
    expect(ids([all], 'revisions')).toHaveLength(41)
  })

  it('refuses a cursor from other arguments or another tool, and an old {ord} cursor; another budget is fine', async () => {
    const first = await page('note_history', { vaultId, path: HISTORY, limit: 5 })
    const cursor = cursorOf(first)
    await refused('note_history', { vaultId, path: BIG, limit: 5, cursor }, /invalid cursor/)
    await refused('note_history', { vaultId, path: HISTORY, limit: 6, cursor }, /invalid cursor/)
    await refused('list_trash', { vaultId, limit: 5, cursor }, /invalid cursor/)
    await refused('note_history', { vaultId, path: HISTORY, cursor: Buffer.from('{"ord":5}').toString('base64url') }, /invalid cursor/)
    const next = await page('note_history', { vaultId, path: HISTORY, limit: 5, cursor, budget_tokens: 1_000 })
    expect(ids([first, next], 'revisions')).toHaveLength(10)
    expect(new Set(ids([first, next], 'revisions')).size).toBe(10)
  })
})

describe('list_trash', () => {
  it('is {notes, truncated}; limit+1 tells there are more; a small budget pages every note once', async () => {
    const first = await page('list_trash', { vaultId, limit: 5 })
    expect(first.notes).toHaveLength(5)
    expect(first.truncated).toMatchObject({ total: { notes: '>5' }, dropped: { notes: 0 } })
    const pages = await walk('list_trash', { vaultId, limit: 100, budget_tokens: 256 })
    expect(pages.length).toBeGreaterThan(1)
    const paths = pages.flatMap((p) => (p.notes as Array<{ path: string }>).map((n) => n.path))
    expect(paths.sort()).toEqual(Array.from({ length: 12 }, (_, i) => `trash/gone-${i}`).sort())
    await refused('list_trash', { vaultId, limit: 99, budget_tokens: 256, cursor: cursorOf(pages[0]!) }, /invalid cursor/)
  })
})

describe('browse_vault and browse_repository', () => {
  it('browse_vault: the whole vault (`recursive: true`) stays within the budget; paging lists every note once, by path', async () => {
    // Every field (#425): the default `{path, title}` items of 48 notes fit one page.
    const args = { vaultId, recursive: true, fields: ['id', 'title', 'type', 'name', 'tags', 'updatedAt'] }
    const first = await page('browse_vault', args)
    expect(first.truncated).not.toBe(false)
    const pages = await walk('browse_vault', { ...args, budget_tokens: LIST_PAGE })
    expect(pages.length).toBeGreaterThan(1)
    const paths = pages.flatMap((p) => (p.notes as Array<{ path: string }>).map((n) => n.path))
    const all = await page('browse_vault', { ...args, budget_tokens: 25_000 })
    expect(all.truncated).toBe(false)
    const allPaths = (all.notes as Array<{ path: string }>).map((n) => n.path)
    expect(allPaths).toHaveLength(48)
    expect(paths).toEqual(allPaths)
    expect([...allPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(allPaths)
  })

  it('browse_vault of a directory pages subdirectories, notes and the index text; a cursor of the whole-vault view is refused', async () => {
    const all = await page('browse_vault', { vaultId, path: 'docs', budget_tokens: 25_000 })
    expect(all.truncated).toBe(false)
    const pages = await walk('browse_vault', { vaultId, path: 'docs', budget_tokens: 256 })
    expect(pages.length).toBeGreaterThan(2)
    expect(pages.flatMap((p) => p.subdirectories as unknown[])).toEqual(all.subdirectories)
    expect(ids(pages, 'notes', (n) => n.path as string)).toEqual(ids([all], 'notes', (n) => n.path as string))
    expect(pages.map((p) => p.indexContent ?? '').join('')).toBe(all.indexContent)
    const whole = await page('browse_vault', { vaultId, recursive: true, budget_tokens: 256 })
    await refused('browse_vault', { vaultId, path: 'docs', budget_tokens: 256, cursor: cursorOf(whole) }, /invalid cursor/)
  })

  it('browse_repository is {files, truncated}; paging lists every file once', async () => {
    const pages = await walk('browse_repository', { repositoryId: repoId, budget_tokens: 256 })
    expect(pages.length).toBeGreaterThan(1)
    const paths = ids(pages, 'files', (f) => f.path as string)
    expect(paths).toHaveLength(32)
    expect(new Set(paths).size).toBe(32)
  })
})

describe('reads cut at line boundaries and continue with the cursor', () => {
  it('read_note: a 4,000-token page, `lines`, the whole body over the pages; a changed note makes the cursor stale', async () => {
    const body = bigBody('first')
    const pages = await walk('read_note', { vaultId, path: BIG })
    expect(pages.length).toBeGreaterThan(5)
    expect(pages.map((p) => p.body).join('')).toBe(body)
    let next = 1
    for (const p of pages) {
      const [a, b] = p.lines as [number, number]
      expect(a).toBe(next)
      next = b + 1
      expect(p).toMatchObject({ path: BIG, frontmatter: expect.any(Object) })
    }
    expect(next - 1).toBe(2_500)
    const first = pages[0]!
    expect((first.body as string).endsWith('\n')).toBe(true)
    expect(first.truncated).toMatchObject({ shown: { body: (first.lines as number[])[1] }, total: { body: 2_500 } })

    await updateNote(vaultId, BIG, { body: bigBody('second') })
    await refused('read_note', { vaultId, path: BIG, cursor: cursorOf(first) }, /stale cursor/)
    await refused('read_note', { vaultId, path: 'docs/small', cursor: cursorOf(first) }, /invalid cursor/)
    await updateNote(vaultId, BIG, { body })
  })

  it('read_note records the last read (#864) only when it returned the whole body', async () => {
    const recorded = async (path: string) => {
      const [read] = await db
        .select({ rev: noteReads.rev })
        .from(noteReads)
        .innerJoin(notes, eq(notes.id, noteReads.noteId))
        .where(and(eq(noteReads.connectionId, agentConnectionId), eq(notes.vaultId, vaultId), eq(notes.path, path)))
      return read
    }
    await page('read_note', { vaultId, path: BIG })
    expect(await recorded(BIG)).toBeUndefined()
    const small = await page('read_note', { vaultId, path: 'docs/small' })
    expect(small.truncated).toBe(false)
    expect(small.body).toBe('A small note.\n')
    expect(small).not.toHaveProperty('lines')
    expect(await recorded('docs/small')).toMatchObject({ rev: small.rev })
  })

  it('get_revision pages the revision body the same way', async () => {
    const [created] = await db
      .select({ id: noteRevisions.id })
      .from(noteRevisions)
      .innerJoin(notes, eq(notes.id, noteRevisions.noteId))
      .where(and(eq(notes.vaultId, vaultId), eq(notes.path, BIG), eq(noteRevisions.action, 'create')))
    const pages = await walk('get_revision', { vaultId, revisionId: created!.id })
    expect(pages.length).toBeGreaterThan(5)
    expect(pages.map((p) => p.body).join('')).toBe(bigBody('first'))
  })

  it('read_file: content pages concatenate to the file, the outline is shown once, other paths refuse the cursor', async () => {
    const pages = await walk('read_file', { repositoryId: repoId, path: 'src/big.ts' })
    expect(pages.length).toBeGreaterThan(5)
    expect(pages.map((p) => p.content).join('')).toBe(bigFile)
    const last = pages.at(-1)!
    expect(last.lines).toEqual([expect.any(Number), 3_000])
    await refused('read_file', { repositoryId: repoId, path: 'src/alpha.ts', cursor: cursorOf(pages[0]!) }, /invalid cursor/)

    const alpha = await page('read_file', { repositoryId: repoId, path: 'src/alpha.ts' })
    expect(alpha.truncated).toBe(false)
    expect(alpha.content).toBe(symbolFile)
    expect(alpha.symbols).toHaveLength(30)
    const cut = await walk('read_file', { repositoryId: repoId, path: 'src/alpha.ts', budget_tokens: 256 })
    expect(cut.map((p) => p.content).join('')).toBe(symbolFile)
    expect(cut.flatMap((p) => p.symbols as unknown[])).toEqual(alpha.symbols)
  })
})

describe('graph, find_graph_path and find_symbols page a stable ranking', () => {
  it('graph: paging shows every node and edge once; a cursor for other filters is refused', async () => {
    const all = await page('graph', { vaultId: graphVaultId, aggregate: 'none', budget_tokens: 25_000 })
    expect(all.truncated).toBe(false)
    // The fixture: the 9 chain links and nothing else (no semantic or structural edge).
    expect(ids([all], 'edges', (e) => e.kind as string)).toEqual(Array.from({ length: 9 }, () => 'extracted'))
    const pages = await walk('graph', { vaultId: graphVaultId, aggregate: 'none', budget_tokens: LIST_PAGE })
    expect(pages.length).toBeGreaterThan(1)
    expect(ids(pages, 'nodes').sort()).toEqual(ids([all], 'nodes').sort())
    expect(ids(pages, 'edges', edge).sort()).toEqual(ids([all], 'edges', edge).sort())
    expect(new Set(ids([all], 'edges', edge)).size).toBe(9)
    await refused('graph', { vaultId: graphVaultId, aggregate: 'none', types: ['c1'], budget_tokens: LIST_PAGE, cursor: cursorOf(pages[0]!) }, /invalid cursor/)
  })

  it('find_graph_path: a path cut by the budget continues with the cursor', async () => {
    const args = { vaultId: graphVaultId, source: 'c0/link', target: 'c9/link' }
    const all = await page('find_graph_path', { ...args, budget_tokens: 25_000 })
    expect(all).toMatchObject({ found: true, distance: 9, truncated: false })
    const pages = await walk('find_graph_path', { ...args, budget_tokens: LIST_PAGE })
    expect(pages.length).toBeGreaterThan(1)
    expect(ids(pages, 'nodes')).toEqual(ids([all], 'nodes'))
    expect(ids(pages, 'edges', edge)).toEqual(ids([all], 'edges', edge))
    expect(ids([all], 'edges', edge)).toEqual(Array.from({ length: 9 }, (_, i) => `c${i}/link -> c${i + 1}/link`))
  })

  it('find_symbols is {results, truncated}: ">limit" from limit+1, paging keeps the ranking, other queries refuse the cursor', async () => {
    const first = await page('find_symbols', { repositoryId: repoId, query: 'alphaHandler', limit: 5 })
    expect(first.results).toHaveLength(5)
    expect(first.truncated).toMatchObject({ total: { results: '>5' }, dropped: { results: 0 } })
    const all = await page('find_symbols', { repositoryId: repoId, query: 'alphaHandler', limit: 50, budget_tokens: 25_000 })
    expect(all.truncated).toBe(false)
    expect((all.results as unknown[]).length).toBe(30)
    const pages = await walk('find_symbols', { repositoryId: repoId, query: 'alphaHandler', limit: 50, budget_tokens: LIST_PAGE })
    expect(pages.length).toBeGreaterThan(2)
    expect(ids(pages, 'results')).toEqual(ids([all], 'results'))
    await refused('find_symbols', { repositoryId: repoId, query: 'other', limit: 50, budget_tokens: LIST_PAGE, cursor: cursorOf(pages[0]!) }, /invalid cursor/)
  })
})

describe('budget_tokens bounds', () => {
  it('refuses a budget under 256 or over 25,000', async () => {
    for (const budget_tokens of [255, 25_001]) {
      const r = await call('read_note', { vaultId, path: 'docs/small', budget_tokens })
      expect(r.isError, String(budget_tokens)).toBe(true)
    }
  })
})
