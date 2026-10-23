// #558: every edge and path step the MCP `graph` and `find_graph_path` tools
// return is the ADR-004 §2.8 row `{from, to, directed, kind, relation,
// confidence, evidence}`: names (not ids), the edge's true direction, why it
// exists and where. Wikilink evidence follows the projected `.md` file after
// body and frontmatter edits. Keeping the direction does not move a single
// community: Louvain still runs on the undirected projection.
// Every case goes through the MCP HTTP path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'
import { inArray, or } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { semanticEdges } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { flushProjections } from '../src/notes/projector.js'
import { createNote, noteFile } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
type Answer = Record<string, unknown> & { truncated: unknown }
interface Endpoint {
  path: string
  in?: string
}
interface Row {
  from: Endpoint
  to: Endpoint
  directed: boolean
  kind: string
  relation: string
  confidence: string | number
  evidence: string | null
}

const VAULT = 'edges vault'
const REPO = 'edges-repo'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

let app: FastifyInstance
let agent: Client
let cookie: string
let vaultId: string
let repoId: string
const idOf: Record<string, string> = {}

async function call(name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

/** One whole answer (a large budget, nothing cut). */
async function answer(name: string, args: Args): Promise<Answer> {
  const r = await call(name, { budget_tokens: 25_000, ...args })
  expect(r.isError, `${name} ${JSON.stringify(args)}: ${r.text.slice(0, 300)}`).toBe(false)
  const json = JSON.parse(r.text) as Answer
  expect(json.truncated).toBe(false)
  return json
}

const graph = (args: Args) => answer('graph', { vaultId, repositoryId: repoId, ...args })
const rowsOf = (json: Answer) => json.edges as Row[]
/** `in`: the container's name and the first 8 characters of its id. */
const note = (path: string): Endpoint => ({ path, in: `${VAULT}#${vaultId.slice(0, 8)}` })
const file = (path: string): Endpoint => ({ path, in: `${REPO}#${repoId.slice(0, 8)}` })
/** A row as a string; an undirected row's ends in either order. */
const rowKey = (r: Row) => {
  const ends = [JSON.stringify(r.from), JSON.stringify(r.to)]
  return JSON.stringify({ ...r, from: undefined, to: undefined, ends: r.directed ? ends : ends.sort() })
}

async function edit(path: string, args: Args): Promise<void> {
  const r = await call('edit_note', { vaultId, path, ...args })
  expect(r.isError, r.text.slice(0, 300)).toBe(false)
}

/** `path#L<n>` (or `#L<a>-L<b>`) of the line of the projected note file that holds `text`, as `git grep -n` finds it. */
async function lineOf(path: string, text: string): Promise<string> {
  await flushProjections()
  const lines = (await readFile(noteFile(vaultId, path), 'utf8')).split('\n')
  const at = lines.findIndex((l) => l.includes(text))
  expect(at, `${text} in ${path}.md`).toBeGreaterThanOrEqual(0)
  expect(lines.filter((l) => l.includes(text)), `${text} once in ${path}.md`).toHaveLength(1)
  return `${path}#L${at + 1}`
}

const words = (w: string) => `${w} `.repeat(40).trim()

/** Only the semantic rows a test inserts: the test embedder's own neighbours are deleted. */
async function onlySemantic(ids: string[], rows: Array<typeof semanticEdges.$inferInsert>): Promise<void> {
  await flushEmbeddings()
  await db.delete(semanticEdges).where(or(inArray(semanticEdges.sourceId, ids), inArray(semanticEdges.targetId, ids)))
  if (rows.length > 0) await db.insert(semanticEdges).values(rows)
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: VAULT } })).json<{ id: string }>().id
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: REPO, ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'graph-edges-agent', scope: 'account' } })
  agent = new Client({ name: 'graph-edges-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )

  // Each body repeats its own word (no semantic edge from the test embedder; SEMANTIC_THRESHOLD=0.2).
  // alpha/one links beta/two twice (lines 3 and 5) and a repository file; gamma/three links alpha/one
  // after a code fence whose wikilink is not a link. alpha/one and beta/two share a tag, gamma/three
  // and gamma/four a type.
  const notes: Array<[string, string, string[]?]> = [
    ['alpha/one', `${words('amber')}\n\nSee [[beta/two]] first.\nThen [[repo:${REPO}/src/main.ts]].\nAgain [[beta/two]].\n`, ['shared']],
    ['beta/two', `${words('birch')}\n`, ['shared']],
    ['gamma/three', `${words('cedar')}\n\`\`\`\n[[not/alink]]\n\`\`\`\nLink: [[alpha/one]]\n`],
    ['gamma/four', `${words('delta')}\n`],
  ]
  for (const [path, body, tags] of notes) {
    idOf[path] = (await createNote(vaultId, { path, body, ...(tags ? { frontmatter: { tags } } : {}) })).id
  }
  // main imports util on line 2; main and util share the language and the folder, README only the folder.
  const files = [
    { path: 'src/main.ts', content: "// main\nimport { util } from './util'\nexport const main = util\n" },
    { path: 'src/util.ts', content: 'export const util = 1\n' },
    { path: 'src/README', content: 'plain words\n' },
  ]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
  const fileRows = await app.inject({ method: 'GET', url: `/api/repositories/${repoId}/files`, headers: { cookie } })
  for (const f of fileRows.json<Array<{ id: string; path: string }>>()) idOf[f.path] = f.id
  // One semantic pair, stored both ways with different similarities: gamma/four and src/README.
  await onlySemantic(Object.values(idOf), [
    { sourceType: 'note', sourceId: idOf['gamma/four']!, targetType: 'code', targetId: idOf['src/README']!, similarity: 0.81 },
    { sourceType: 'code', sourceId: idOf['src/README']!, targetType: 'note', targetId: idOf['gamma/four']!, similarity: 0.874 },
  ])
}, 120_000)

afterAll(async () => {
  await agent?.close().catch(() => {})
  await app.close()
})

/** The rows the fixture must give, with the link lines read from the projected files. */
async function expectedRows(): Promise<Row[]> {
  const link = (from: string, to: Endpoint, evidence: string): Row => ({ from: note(from), to, directed: true, kind: 'extracted', relation: 'link', confidence: 'resolved', evidence })
  const group = (a: Endpoint, b: Endpoint, relation: string, evidence: string): Row => ({ from: a, to: b, directed: false, kind: 'structural', relation, confidence: 'resolved', evidence })
  return [
    // The first of alpha/one's two links to beta/two.
    link('alpha/one', note('beta/two'), await lineOf('alpha/one', 'See [[beta/two]]')),
    link('alpha/one', file('src/main.ts'), await lineOf('alpha/one', `[[repo:${REPO}/src/main.ts]]`)),
    link('gamma/three', note('alpha/one'), await lineOf('gamma/three', '[[alpha/one]]')),
    { from: file('src/main.ts'), to: file('src/util.ts'), directed: true, kind: 'extracted', relation: 'import', confidence: 'resolved', evidence: 'src/main.ts#L2' },
    group(note('alpha/one'), note('beta/two'), 'same_tag', 'tag:shared'),
    group(note('gamma/three'), note('gamma/four'), 'same_type', 'type:gamma'),
    // main and util share the language and the folder: one row, the language ranks first.
    group(file('src/main.ts'), file('src/util.ts'), 'same_language', 'language:typescript'),
    group(file('src/main.ts'), file('src/README'), 'same_folder', 'folder:src'),
    group(file('src/util.ts'), file('src/README'), 'same_folder', 'folder:src'),
    // Both stored directions merge into one undirected row with the higher similarity, 2 decimals.
    { from: note('gamma/four'), to: file('src/README'), directed: false, kind: 'semantic', relation: 'similar', confidence: 0.87, evidence: null },
  ]
}

describe('graph edge rows (#558)', () => {
  it('the fixture: 4 extracted, 5 structural and 1 semantic edge', async () => {
    const rows = rowsOf(await graph({ aggregate: 'none' }))
    expect(rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {})).toEqual({ extracted: 4, structural: 5, semantic: 1 })
  })

  it('every edge kind is a row with names, direction, relation, confidence and evidence; no ids', async () => {
    const json = await graph({ aggregate: 'none' })
    const rows = rowsOf(json)
    expect(rows.map(rowKey).sort()).toEqual((await expectedRows()).map(rowKey).sort())
    expect(JSON.stringify(rows)).not.toMatch(UUID)
    // Nodes keep their ids (neighborsOf and community take them); edges name their ends.
    expect((json.nodes as Array<{ id: string }>).every((n) => UUID.test(n.id))).toBe(true)
  })

  it('a code fence above a link does not shift its line, and its own [[…]] is no edge', async () => {
    const rows = rowsOf(await graph({ aggregate: 'none' }))
    const fromGamma = rows.filter((r) => r.from.path === 'gamma/three' && r.kind === 'extracted')
    expect(fromGamma).toHaveLength(1)
    expect(fromGamma[0]!.evidence).toBe(await lineOf('gamma/three', 'Link: [[alpha/one]]'))
  })

  it('neighborsOf lists the same rows as the whole graph, around a note and around a file', async () => {
    const full = rowsOf(await graph({ aggregate: 'none' })).map(rowKey).sort()
    expect(rowsOf(await graph({ neighborsOf: 'alpha/one', depth: 3 })).map(rowKey).sort()).toEqual(full)
    const local = rowsOf(await graph({ neighborsOf: 'src/README', depth: 1 })).map(rowKey).sort()
    expect(local.length).toBeGreaterThan(0)
    for (const key of local) expect(full).toContain(key)
  })

  it('one container: no `in`', async () => {
    const rows = rowsOf(await answer('graph', { repositoryId: repoId, aggregate: 'none' }))
    expect(rows).toContainEqual({ from: { path: 'src/main.ts' }, to: { path: 'src/util.ts' }, directed: true, kind: 'extracted', relation: 'import', confidence: 'resolved', evidence: 'src/main.ts#L2' })
    for (const r of rows) expect(Object.keys(r.from).concat(Object.keys(r.to))).toEqual(['path', 'path'])
  })
})

describe('find_graph_path steps (#558)', () => {
  it('each step is a row in its true direction, also where the path walks it backwards', async () => {
    const json = await answer('find_graph_path', { vaultId, repositoryId: repoId, source: 'src/main.ts', target: 'gamma/three' })
    expect(json).toMatchObject({ found: true, distance: 2 })
    expect((json.nodes as Array<{ path: string }>).map((n) => n.path)).toEqual(['src/main.ts', 'alpha/one', 'gamma/three'])
    expect(rowsOf(json)).toEqual([
      { from: note('alpha/one'), to: file('src/main.ts'), directed: true, kind: 'extracted', relation: 'link', confidence: 'resolved', evidence: await lineOf('alpha/one', `[[repo:${REPO}/src/main.ts]]`) },
      { from: note('gamma/three'), to: note('alpha/one'), directed: true, kind: 'extracted', relation: 'link', confidence: 'resolved', evidence: await lineOf('gamma/three', '[[alpha/one]]') },
    ])
  })
})

describe('wikilink evidence after edits (#558)', () => {
  it('follows the projected file after a body edit and after a frontmatter-only edit', async () => {
    const evidence = async () => rowsOf(await graph({ aggregate: 'none' })).find((r) => r.relation === 'link' && r.from.path === 'alpha/one' && r.to.path === 'beta/two')!.evidence
    const before = await evidence()
    // Two lines above the link.
    await edit('alpha/one', { ops: [{ op: 'prepend', text: 'Intro line.\nSecond intro line.' }] })
    const afterBody = await evidence()
    expect(afterBody).toBe(await lineOf('alpha/one', 'See [[beta/two]]'))
    expect(Number(/#L(\d+)/.exec(afterBody!)![1])).toBe(Number(/#L(\d+)/.exec(before!)![1]) + 2)
    // A new frontmatter key: the body (and its stored link rows) is unchanged, its lines in the file move.
    await edit('alpha/one', { frontmatter: { summary: 'one more frontmatter line' } })
    const afterFrontmatter = await evidence()
    expect(afterFrontmatter).toBe(await lineOf('alpha/one', 'See [[beta/two]]'))
    expect(Number(/#L(\d+)/.exec(afterFrontmatter!)![1])).toBe(Number(/#L(\d+)/.exec(afterBody!)![1]) + 1)
    // The link moved to another line: the evidence follows it.
    await edit('alpha/one', { ops: [{ op: 'replace_text', find: 'See [[beta/two]] first.', replace: 'See first.' }] })
    expect(await evidence()).toBe(await lineOf('alpha/one', 'Again [[beta/two]]'))
  })
})

describe('direction and communities (#558)', () => {
  it('a reverse link is its own directed row and moves no community', async () => {
    const vault = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'edges communities' } })).json<{ id: string }>().id
    const paths = ['k0/n', 'k1/n', 'k2/n', 'k3/n', 'k4/n', 'k5/n']
    const ids: Record<string, string> = {}
    for (const [i, path] of paths.entries()) ids[path] = (await createNote(vault, { path, body: `${words(['ember', 'fjord', 'glyph', 'heron', 'indigo', 'jasper'][i]!)}\n` })).id
    // Ranked by id: links go from the lower id to the higher, so each pair is first met at the same place either way.
    const s = [...paths].sort((a, b) => (ids[a]! < ids[b]! ? -1 : 1))
    const pairs: Array<[number, number]> = [[0, 1], [0, 2], [1, 2], [2, 3], [3, 4], [3, 5], [4, 5]]
    const linksFrom = (i: number, reverse: boolean) => pairs.filter(([a, b]) => (reverse ? b : a) === i).map(([a, b]) => `[[${s[reverse ? a : b]}]]`)
    const append = async (reverse: boolean) => {
      for (let i = 0; i < s.length; i++) {
        const links = linksFrom(i, reverse)
        if (links.length === 0) continue
        const r = await call('edit_note', { vaultId: vault, path: s[i]!, ops: [{ op: 'append', text: links.join(' ') }] })
        expect(r.isError, r.text.slice(0, 300)).toBe(false)
      }
      await onlySemantic(Object.values(ids), [])
    }
    const snapshot = async () => {
      const list = await answer('graph', { vaultId: vault, aggregate: 'none' })
      return {
        communities: Object.fromEntries((list.nodes as Array<{ id: string; community: number }>).map((n) => [n.id, n.community])),
        view: await answer('graph', { vaultId: vault }),
        rows: rowsOf(list),
      }
    }

    await append(false)
    const one = await snapshot()
    expect(one.rows).toHaveLength(pairs.length)
    await append(true)
    const both = await snapshot()
    // Every link both ways: twice the rows, each in its own direction.
    expect(both.rows).toHaveLength(2 * pairs.length)
    for (const [a, b] of pairs) {
      for (const [from, to] of [[s[a]!, s[b]!], [s[b]!, s[a]!]]) {
        expect(both.rows.filter((r) => r.from.path === from && r.to.path === to)).toEqual([expect.objectContaining({ directed: true, relation: 'link' })])
      }
    }
    // Louvain sees the same undirected graph: the same community for every node, the same community view and weights.
    expect(both.communities).toEqual(one.communities)
    // (`lastActivity` moved: the reverse links were written after.)
    const view = (v: Answer) => ({ nodes: (v.nodes as Array<Record<string, unknown>>).map((c) => ({ ...c, lastActivity: undefined })), edges: v.edges })
    expect(view(both.view)).toEqual(view(one.view))
    expect(new Set(Object.values(one.communities)).size).toBeGreaterThan(1)
  })
})
