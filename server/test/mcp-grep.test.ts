// #468: `grep` matches a regular expression line by line over notes and indexed code and answers located hits
// (`path`, `line`, `block`, `tokens`, `snippet`; `lines` when `context` widens the snippet) in path then line order.
// Lines are those of `read_note` / `read_file`; the scan is bounded (pattern length, no back references, a cap on
// files scanned that ends the list with a marker and a cursor). Another account's data is not reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { blocks, repositoryFiles } from '../src/db/schema.js'
import { and, eq } from 'drizzle-orm'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let app: FastifyInstance
let baseUrl: string
let cookie: string
let vaultId: string
let repoId: string
let agent: Client
let stranger: Client
let strangerVaultId: string
const clients: Client[] = []

const FILES: Record<string, string> = {
  'src/store.ts': ['export class Store {', '  save(value: string) {', '    return normalize(value)', '  }', '}', '', 'export function normalize(s: string) {', '  return s.trim() // TODO: unicode', '}', ''].join('\n'),
  'src/handler.ts': ["import { normalize } from './store'", '', 'export function handle(x: string) {', '  return normalize(x)', '}', ''].join('\n'),
  'lib/util.py': ['def normalize(s):', '    return s.strip()  # TODO: unicode', '', 'def run(x):', '    return normalize(x)', ''].join('\n'),
  'cmd/main.go': ['package main', '', 'func Normalize(s string) string {', '\treturn s // TODO: unicode', '}', ''].join('\n'),
  'docs/crlf.txt': 'first\r\nsecond TODO\r\nthird\r\n',
  'docs/blank.txt': 'a\n\nb\n',
}

async function connect(c: string, name: string): Promise<Client> {
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: c }, body: { name, scope: 'account' } })
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }))
  clients.push(client)
  return client
}

async function call(who: Client, tool: string, args: Record<string, unknown>) {
  resetRateLimits()
  const result = await who.callTool({ name: tool, arguments: args })
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
  return { isError: result.isError === true, text, json: JSON.parse((result.content as Array<{ text?: string }>)[0]!.text!) as Json }
}
const grep = (args: Record<string, unknown>, who = agent) => call(who, 'grep', args)
const at = (hits: Json[]) => hits.map((h) => `${h.path}:${h.line}`)

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'grep-notes' } })).json<{ id: string }>().id
  const repo = async (c: string, name: string) => (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie: c }, body: { name, ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  repoId = await repo(cookie, 'grep-code')
  agent = await connect(cookie, 'grep-agent')
  await syncRepositoryFiles(repoId, Object.entries(FILES).map(([path, content]) => ({ path, content })), Object.keys(FILES))
  await flushExtraction()
  // A note whose file has a three-line frontmatter before the body: its lines are those of read_note's file.
  await createNote(vaultId, { path: 'guides/retry', frontmatter: { tags: ['retry', 'upload'] }, body: '# Retry\n\nBack off on every failure.\nTODO: jitter\n\n## Limits\n\nAt most five tries.\n' })
  await createNote(vaultId, { path: 'journal/day', body: 'Nothing happened.\nTODO: write down what.\n' })
  const other = await createActiveUser()
  const otherCookie = await loginCookie(app, other.email)
  strangerVaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: otherCookie }, body: { name: 'grep-secret' } })).json<{ id: string }>().id
  await createNote(strangerVaultId, { path: 'secret/plan', body: 'TODO: the secret plan\n' })
  const strangerRepo = await repo(otherCookie, 'grep-secret-code')
  await syncRepositoryFiles(strangerRepo, [{ path: 'secret.ts', content: '// TODO: secret\n' }], ['secret.ts'])
  stranger = await connect(otherCookie, 'grep-stranger')
}, 120_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('grep over code (#468)', () => {
  it('finds a regex in files of several languages: path then line order, one hit per line, with the indexed version', async () => {
    const r = await grep({ repositoryId: repoId, pattern: 'normalize|Normalize' })
    expect(r.isError, r.text).toBe(false)
    expect(at(r.json.hits)).toEqual(['cmd/main.go:3', 'lib/util.py:1', 'lib/util.py:5', 'src/handler.ts:1', 'src/handler.ts:4', 'src/store.ts:3', 'src/store.ts:7'])
    expect(r.json.hits[0]).toMatchObject({ path: 'cmd/main.go', line: 3, snippet: 'func Normalize(s string) string {' })
    expect(r.json.hits[0].lines).toBeUndefined()
    expect(r.json.truncated).toBe(false)
    expect(r.json.commit ?? r.json.tree).toBeDefined()
  })

  it('a hit names the smallest block holding its line and what reading it costs; the block reads back with the line in it', async () => {
    const r = await grep({ repositoryId: repoId, pattern: 'TODO: unicode', path: 'src/**' })
    const [hit] = r.json.hits
    expect([hit.path, hit.line]).toEqual(['src/store.ts', 8])
    expect(hit.block).toEqual(expect.any(String))
    expect(hit.tokens).toBeGreaterThan(0)
    const read = await call(agent, 'read_file', { repositoryId: repoId, path: 'src/store.ts', targets: [{ block: hit.block }] })
    expect(read.isError, read.text).toBe(false)
    expect(read.text).toContain('TODO: unicode')
  })

  it('path globs: `*.ext` at any depth, `**`, a folder, `{a,b}` and `?`', async () => {
    const files = async (path: string) => [...new Set((await grep({ repositoryId: repoId, pattern: 'TODO', path })).json.hits.map((h: Json) => h.path))]
    expect(await files('*.py')).toEqual(['lib/util.py'])
    expect(await files('src/*.ts')).toEqual(['src/store.ts'])
    expect(await files('**/*.{go,py}')).toEqual(['cmd/main.go', 'lib/util.py'])
    expect(await files('{lib,cmd}/**')).toEqual(['cmd/main.go', 'lib/util.py'])
    expect(await files('docs/cr?f.txt')).toEqual(['docs/crlf.txt'])
    expect(await files('nothing/**')).toEqual([])
  })

  it('context lines widen the snippet to `lines`, cut at the file edges', async () => {
    const r = await grep({ repositoryId: repoId, pattern: 'package main', context: 2 })
    expect(r.json.hits).toEqual([expect.objectContaining({ path: 'cmd/main.go', line: 1, lines: [1, 3], snippet: 'package main\n\nfunc Normalize(s string) string {' })])
    const middle = await grep({ repositoryId: repoId, pattern: 'return s\\.trim', context: 1 })
    expect(middle.json.hits[0]).toMatchObject({ line: 8, lines: [7, 9], snippet: 'export function normalize(s: string) {\n  return s.trim() // TODO: unicode\n}' })
    expect((await grep({ repositoryId: repoId, pattern: 'x', context: 6 })).isError).toBe(true)
  })

  it('lines: `$` matches before a CRLF, a final newline has no line after it, an empty line is a line', async () => {
    expect(at((await grep({ repositoryId: repoId, pattern: 'TODO$', path: 'docs/crlf.txt' })).json.hits)).toEqual(['docs/crlf.txt:2'])
    expect(at((await grep({ repositoryId: repoId, pattern: '^$', path: 'docs/*.txt' })).json.hits)).toEqual(['docs/blank.txt:2'])
  })

  it('`\\b` is a word boundary, `(?i)` ignores case, a character class and a lazy quantifier work', async () => {
    expect(at((await grep({ repositoryId: repoId, pattern: '\\bnormalize\\b', path: 'src/store.ts' })).json.hits)).toEqual(['src/store.ts:3', 'src/store.ts:7'])
    expect(at((await grep({ repositoryId: repoId, pattern: '(?i)^func normalize', path: '*.go' })).json.hits)).toEqual(['cmd/main.go:3'])
    expect(at((await grep({ repositoryId: repoId, pattern: '[[:space:]]*return [a-z]+?\\(x\\)' })).json.hits)).toEqual(['lib/util.py:5', 'src/handler.ts:4'])
  })
})

describe('the block a hit names (#1083)', () => {
  it('is the symbol block when a file block starts on the same line, whatever the block ids sort like', async () => {
    // A file that is one function: its `symbol` block and its file block have one span, so the kind decides, not the row order.
    await syncRepositoryFiles(repoId, [{ path: 'tiny/only.py', content: 'def only(x):\n    return x\n' }], [...Object.keys(FILES), 'tiny/only.py'])
    await flushExtraction()
    const [file] = await db.select({ id: repositoryFiles.id }).from(repositoryFiles).where(and(eq(repositoryFiles.repositoryId, repoId), eq(repositoryFiles.path, 'tiny/only.py')))
    const rows = await db.select().from(blocks).where(eq(blocks.ownerId, file!.id))
    const symbol = rows.find((b) => b.kind === 'symbol' && b.startLine === 1)!
    const spanning = rows.filter((b) => b.kind !== 'symbol' && b.startLine === 1 && b.endLine - b.startLine === symbol.endLine - symbol.startLine)
    // Precondition: some other block has the symbol's exact span, else this case proves nothing.
    expect(spanning.length, 'a block of the same span as the symbol').toBeGreaterThan(0)
    const original = rows.map((b) => [b.id, b.blockId] as const)
    try {
      for (const [lowFirst, label] of [[true, 'symbol id first'], [false, 'symbol id last']] as const) {
        // Re-key the blocks so the symbol's id sorts first or last among the file's blocks.
        const ordered = [...rows].sort((a, b) => (a.id === symbol.id ? -1 : b.id === symbol.id ? 1 : 0) * (lowFirst ? 1 : -1))
        for (const [i, b] of ordered.entries()) await db.update(blocks).set({ blockId: `b_order${lowFirst ? 'a' : 'b'}${String(i).padStart(4, '0')}` }).where(eq(blocks.id, b.id))
        const r = await grep({ repositoryId: repoId, pattern: '^def only', path: 'tiny/only.py' })
        const symbolId = (await db.select({ blockId: blocks.blockId }).from(blocks).where(eq(blocks.id, symbol.id)))[0]!.blockId
        expect(r.json.hits[0].block, label).toBe(symbolId)
      }
    } finally {
      for (const [id, blockId] of original) await db.update(blocks).set({ blockId }).where(eq(blocks.id, id))
    }
  })
})

describe('grep over notes (#468)', () => {
  it('numbers lines as read_note does, over the note file: the frontmatter counts', async () => {
    const r = await grep({ vaultId, pattern: 'TODO' })
    expect(at(r.json.hits)).toEqual(['guides/retry:11', 'journal/day:6'])
    const hit = r.json.hits[0]
    const read = await call(agent, 'read_note', { vaultId, path: 'guides/retry', targets: [{ lines: `${hit.line}-${hit.line}` }] })
    expect(read.text).toContain('TODO: jitter')
    expect(hit).toMatchObject({ snippet: 'TODO: jitter', block: expect.any(String), tokens: expect.any(Number) })
    const block = await call(agent, 'read_note', { vaultId, path: 'guides/retry', targets: [{ block: hit.block }] })
    expect(block.text).toContain('TODO: jitter')
  })

  it('searches the vault and the repository together: `everywhere` names each hit\'s source and keeps vaults before repositories', async () => {
    const r = await grep({ everywhere: true, pattern: 'TODO: (unicode|jitter)', path: '**/{retry,store.ts}' })
    expect(r.json.hits.map((h: Json) => [h.vaultId ?? h.repositoryId, h.path])).toEqual([
      [vaultId, 'guides/retry'],
      [repoId, 'src/store.ts'],
    ])
  })
})

describe('grep bounds (#468)', () => {
  it('a refused pattern: back reference, empty, too long, invalid; a ReDoS-shaped one is bounded', async () => {
    const code = async (pattern: string) => {
      const r = await grep({ repositoryId: repoId, pattern })
      return [r.isError, r.json.error?.code]
    }
    expect(await code('(a)\\1')).toEqual([true, 'INVALID_ARGUMENT'])
    expect(await code('')).toEqual([true, 'INVALID_ARGUMENT'])
    expect(await code('a'.repeat(301))).toEqual([true, 'INVALID_ARGUMENT'])
    expect(await code('(unclosed')).toEqual([true, 'INVALID_ARGUMENT'])
    const started = Date.now()
    await db.insert(repositoryFiles).values({ repositoryId: repoId, path: 'redos.txt', content: `${'a'.repeat(5_000)}!\n`, contentHash: 'redos', size: 5_001 })
    expect(await code('^(a+)+$')).toEqual([false, undefined])
    expect(await code('(a|aa)+$')).toEqual([false, undefined])
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('pages with the cursor: the pages are the whole answer, in order', async () => {
    const seen: string[] = []
    const sizes: number[] = []
    let cursor: string | undefined
    // 60 matching lines in one file: more than a page of 20 (MCP_PAGE_HITS).
    await db.insert(repositoryFiles).values({ repositoryId: repoId, path: 'many.txt', content: `${Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join('\n')}\n`, contentHash: 'many', size: 1 })
    for (let page = 0; page < 4; page++) {
      const r = await grep({ repositoryId: repoId, pattern: '^row', ...(cursor ? { cursor } : {}) })
      seen.push(...at(r.json.hits))
      sizes.push(r.json.hits.length)
      cursor = r.json.truncated === false ? undefined : (r.json.truncated.cursor ?? undefined)
      if (!cursor) break
    }
    expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => `many.txt:${i + 1}`))
    expect(cursor).toBeUndefined()
    // A page is at most 20 hits over MCP (#1122), even when the budget would show more.
    expect(sizes).toEqual([20, 20, 20])
  })

})

describe('grep access (#468)', () => {
  it("does not reach another account's vault or repository, and `everywhere` does not list them", async () => {
    const secretRepo = (await call(stranger, 'list_repositories', {})).json[0].id as string
    for (const args of [{ vaultId: strangerVaultId }, { repositoryId: secretRepo }]) {
      const r = await grep({ ...args, pattern: 'TODO' })
      expect([r.isError, r.json.error?.code], JSON.stringify(args)).toEqual([true, 'NOT_FOUND'])
    }
    const everywhere = await grep({ everywhere: true, pattern: 'secret' })
    expect(everywhere.text).not.toContain('secret')
    expect((await grep({ everywhere: true, pattern: 'TODO' }, stranger)).json.hits.map((h: Json) => h.path).sort()).toEqual(['secret.ts', 'secret/plan'])
  })

  it('the same question twice is the same bytes', async () => {
    const q = { everywhere: true, pattern: 'normalize', context: 1 }
    expect((await grep(q)).text).toBe((await grep(q)).text)
  })
})
