// #473 (ADR-004 §1.3): no LLM on the query path, so the same question against
// the same index gives the same bytes. Two worlds hold one fixture vault and
// repository, built by two accounts:
//  - physical order and history: world A creates the notes in fixture order
//    and syncs the files in one push; world B creates the notes in reverse,
//    each embedded before the next, and pushes the files one at a time in
//    reverse;
//  - id order: every note, file and block id is assigned so that the ids
//    sort in fixture order in A and in reverse fixture order in B (`rankedId`;
//    asserted after the build). Rows that tie on content (twins/a and
//    twins/b, the three `parse` symbols, Retrier and Retrier.retry) therefore
//    have opposite id orders, and any tie-break by id changes B's answer:
//    random ids would hide it in half the runs or more.
// Every read tool is asked each question twice in world A: the raw answers
// must be byte-identical. That half only catches randomness inside one
// process (one database's ids sort the same way every time); id dependence
// is caught by asking world B, whose answers must be byte-identical once the
// values that are generated per database are masked.
//
// Masking is an allowlist, never a wholesale scrub:
//  - ids: the world's own vault, repository, note, file and block ids
//    (and the 8-character prefixes names carry), each replaced by a label
//    built from its fixture path;
//  - times: the values of the keys in TIME_KEYS.
// Anything else that differs fails the test.
//
// A question `dev` answers differently in the other database names its issue
// in `differs`: its cross-database case is `it.fails`, so the fix turns it red
// and the fix PR removes the marker. The causes the graph cases mix are also
// pinned one per issue at the end, as `it.fails`.
import type * as Crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray, sql } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { blocks, notes, repositoryFiles } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { flushProjections } from '../src/notes/projector.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction, scheduleImportReresolution } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

// createNote takes its id from `randomUUID()`: the next one is queued here before each call.
const queuedIds = vi.hoisted(() => [] as string[])
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>()
  return { ...actual, randomUUID: () => queuedIds.shift() ?? actual.randomUUID() }
})
const { randomUUID } = await vi.importActual<typeof Crypto>('node:crypto')

/**
 * A fresh id whose first 8 hex digits are `rank`, the rest random: ids sort
 * by rank (Postgres compares uuids byte by byte, JS hex strings alike).
 */
function rankedId(rank: number): string {
  return `${rank.toString(16).padStart(8, '0')}${randomUUID().slice(8)}`
}

type Args = Record<string, unknown>

const VAULT = 'determinism vault'
const REPO = 'determinism-repo'

/** Keys whose values are times: the only values besides ids that may differ between the worlds. */
const TIME_KEYS = ['timestamp', 'updated', 'updatedAt', 'lastActivity']
/** Tools without a token budget (no `budget_tokens` argument). */
const UNBUDGETED = ['repository_status']

// Ties on purpose: twins/a and twins/b have one body (equal keyword and vector
// scores); src/upload.ts, src/retry.ts and lib/util.py each declare `parse`.
const NOTES: Array<{ path: string; body: string; frontmatter?: Record<string, unknown> }> = [
  {
    path: 'index',
    body: `# Upload pipeline\n\nHow an upload travels. See [[guides/retry]] and [[guides/resume]].\nThe code is [[repo:${REPO}/src/upload.ts]].\n`,
    frontmatter: { tags: ['pipeline'] },
  },
  { path: 'guides/retry', body: '# Retry\n\nRetry a failed upload with exponential backoff. Back to [[index]].\n', frontmatter: { tags: ['pipeline', 'retry'] } },
  { path: 'guides/resume', body: '# Resume\n\nResume an interrupted upload from the last acknowledged chunk.\n', frontmatter: { tags: ['pipeline'] } },
  { path: 'twins/a', body: 'Checksum every chunk before the upload starts.\n' },
  { path: 'twins/b', body: 'Checksum every chunk before the upload starts.\n' },
  { path: 'journal/2026-10-01', body: 'Parsed the upload manifest; see [[twins/a]].\n', frontmatter: { type: 'journal', tags: ['log'] } },
  { path: 'journal/2026-10-02', body: 'Parsed the retry manifest; see [[twins/b]].\n', frontmatter: { type: 'journal', tags: ['log'] } },
]

const FILES: Array<{ path: string; content: string }> = [
  {
    path: 'src/upload.ts',
    content: [
      "import { checksum } from './checksum'",
      '',
      '/** Uploads one chunk after its checksum. */',
      'export function upload(chunk: string): string {',
      '  return checksum(chunk)',
      '}',
      '',
      'export function parse(manifest: string): string[] {',
      "  return manifest.split('\\n')",
      '}',
      '',
    ].join('\n'),
  },
  { path: 'src/checksum.ts', content: '/** A chunk checksum. */\nexport function checksum(chunk: string): string {\n  return String(chunk.length)\n}\n' },
  {
    path: 'src/retry.ts',
    content: [
      "import { upload } from './upload'",
      '',
      'export class Retrier {',
      '  retry(chunk: string): string { return upload(chunk) }',
      '}',
      '',
      'export function parse(manifest: string): string[] {',
      "  return manifest.split(',')",
      '}',
      '',
    ].join('\n'),
  },
  { path: 'lib/util.py', content: 'def parse(manifest):\n    return manifest.split()\n' },
  { path: 'README.md', content: '# determinism-repo\n\nUpload, retry and checksum chunks.\n' },
]

interface World {
  agent: Client
  vaultId: string
  repoId: string
  /** Generated id → its label, longest first when applied. */
  labels: Array<[string, string]>
  /** The labels of the world's notes, files and blocks, in id order (as Postgres sorts the ids). */
  idOrder: () => Promise<string[][]>
}

let app: FastifyInstance
let baseUrl: string
let A: World
let B: World

async function buildWorld(name: string, reverse: boolean): Promise<World> {
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  const vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: VAULT } })).json<{ id: string }>().id
  const repoId = (
    await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: REPO, ingestionMethod: 'agent_push' } })
  ).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: `determinism-${name}`, scope: 'account' } })
  const agent = new Client({ name: `determinism-${name}`, version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  /** The id of the `index`-th row of a fixture list: ascending in A, descending in B. */
  const idAt = (index: number) => rankedId(reverse ? 0xffffffff - index : index)

  const labels: Array<[string, string]> = [
    [vaultId, '<vault>'],
    [repoId, '<repository>'],
  ]
  const ownerLabel = new Map<string, string>()
  for (const n of reverse ? [...NOTES].reverse() : NOTES) {
    const id = idAt(NOTES.indexOf(n))
    queuedIds.push(id)
    const created = await createNote(vaultId, { path: n.path, body: n.body, ...(n.frontmatter ? { frontmatter: n.frontmatter } : {}) })
    if (created.id !== id || queuedIds.length > 0) throw new Error(`${n.path}: createNote did not take the queued id ${id} (got ${created.id})`)
    ownerLabel.set(id, `<note:${n.path}>`)
    // World B: each note is embedded (and finds its neighbours) before the next exists.
    if (reverse) await flushEmbeddings()
  }
  // A file's row is inserted empty under its id just before its push, which then fills it: an update keeps the id.
  // The insert creates the path outside syncRepositoryFiles, so it reports the new path as a sync's insert does (#1008).
  const placeFile = async (f: (typeof FILES)[number]) => {
    const id = idAt(FILES.indexOf(f))
    await db.insert(repositoryFiles).values({ id, repositoryId: repoId, path: f.path, content: '', contentHash: '', size: 0 })
    scheduleImportReresolution(repoId, { manifests: false, paths: [f.path] })
    ownerLabel.set(id, `<file:${f.path}>`)
  }
  if (reverse) {
    const pushed: string[] = []
    for (const f of [...FILES].reverse()) {
      pushed.push(f.path)
      await placeFile(f)
      await syncRepositoryFiles(repoId, [f], [...pushed])
      await flushExtraction()
    }
  } else {
    for (const f of FILES) await placeFile(f)
    await syncRepositoryFiles(repoId, FILES, FILES.map((f) => f.path))
  }
  await flushExtraction()
  await flushEmbeddings()
  await flushProjections()

  // Blocks get their ids last, in the order of their labels (no row references a block id).
  const owned = await db
    .select({ id: blocks.id, ownerId: blocks.ownerId, kind: blocks.kind, innerPath: blocks.innerPath, startLine: blocks.startLine })
    .from(blocks)
    .where(inArray(blocks.containerId, [vaultId, repoId]))
  const blockLabels = owned
    .map((b) => ({ old: b.id, label: `<block:${ownerLabel.get(b.ownerId) ?? b.ownerId}:${b.kind}:${b.innerPath}:${b.startLine}>` }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  if (new Set(blockLabels.map((b) => b.label)).size !== blockLabels.length) throw new Error('two blocks share a label: their id order would be random')
  const renamed = blockLabels.map((b, i) => ({ ...b, id: idAt(i) }))
  await db.execute(sql`UPDATE blocks b SET id = u.id FROM jsonb_to_recordset(${JSON.stringify(renamed)}::jsonb) AS u(old uuid, id uuid) WHERE b.id = u.old`)
  for (const b of renamed) labels.push([b.id, b.label])
  for (const [id, label] of ownerLabel) labels.push([id, label])
  // Names carry the container's first 8 id characters (`name#1a2b3c4d`).
  labels.push([vaultId.slice(0, 8), '<vault8>'], [repoId.slice(0, 8), '<repository8>'])
  labels.sort((a, b) => b[0].length - a[0].length)

  const label = (id: string) => labels.find(([known]) => known === id)?.[1] ?? id
  const idOrder = async () => [
    (await db.select({ id: notes.id }).from(notes).where(eq(notes.vaultId, vaultId)).orderBy(notes.id)).map((r) => label(r.id)),
    (await db.select({ id: repositoryFiles.id }).from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repoId)).orderBy(repositoryFiles.id)).map((r) => label(r.id)),
    (await db.select({ id: blocks.id }).from(blocks).where(inArray(blocks.containerId, [vaultId, repoId])).orderBy(blocks.id)).map((r) => label(r.id)),
  ]
  return { agent, vaultId, repoId, labels, idOrder }
}

/** One answer, serialized as it came over the wire: `content` blocks, `structuredContent` and `isError`. */
async function ask(world: World, tool: string, args: Args): Promise<string> {
  resetRateLimits()
  const budget = UNBUDGETED.includes(tool) ? {} : { budget_tokens: 25_000 }
  const result = await world.agent.callTool({ name: tool, arguments: { ...budget, ...args } })
  return JSON.stringify({ isError: result.isError === true, content: result.content, structuredContent: result.structuredContent })
}

/** The values under TIME_KEYS anywhere in `value`, each with its key. */
function times(value: unknown, into: Map<string, string>): Map<string, string> {
  if (Array.isArray(value)) for (const v of value) times(v, into)
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (TIME_KEYS.includes(k) && typeof v === 'string') into.set(v, k)
      else times(v, into)
    }
  }
  return into
}

/** The time values of one raw answer (its `structuredContent` and its JSON text blocks), each with its key. */
function answerTimes(raw: string): Map<string, string> {
  const parsed = JSON.parse(raw) as { content: Array<{ text?: string }>; structuredContent?: unknown }
  const found = times(parsed.structuredContent, new Map())
  for (const c of parsed.content) {
    try {
      times(JSON.parse(c.text ?? ''), found)
    } catch {
      // A text block that is not JSON (read_note's body) holds no keyed time.
    }
  }
  return found
}

/** The answer with the world's generated ids and the allowlisted times replaced by labels. */
function mask(world: World, raw: string): string {
  let out = raw
  // Longest first: a date (`updated`) is a prefix of a timestamp.
  for (const t of [...answerTimes(raw).keys()].sort((a, b) => b.length - a.length)) out = out.split(t).join('<time>')
  for (const [id, label] of world.labels) out = out.split(id).join(label)
  return out
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  A = await buildWorld('a', false)
  B = await buildWorld('b', true)
  // The precondition of the cross-database cases: every id order of B is A's reversed.
  const [a, b] = [await A.idOrder(), await B.idOrder()]
  expect(b, 'B holds its notes, files and blocks in the reverse id order of A').toEqual(a.map((ids) => [...ids].reverse()))
}, 120_000)

afterAll(async () => {
  await A?.agent.close().catch(() => {})
  await B?.agent.close().catch(() => {})
  await app.close()
})

interface Question {
  name: string
  tool: string
  /** The arguments in a world (its container ids). */
  args: (w: World) => Args
  /** Why `dev` answers it differently in the other database: its cross-database case is `it.fails` until that issue is fixed. */
  differs?: string
}

/** Each node's semantic neighbours were those that existed when it was embedded (fixed: its pinned case below passes). */
const SEMANTIC_HISTORY = '#1007'

const QUESTIONS: Question[] = [
  { name: 'search notes', tool: 'search', args: (w) => ({ vaultId: w.vaultId, query: 'upload chunk' }) },
  { name: 'search two notes with one body', tool: 'search', args: (w) => ({ vaultId: w.vaultId, query: 'checksum every chunk' }) },
  { name: 'search code and symbols', tool: 'search', args: (w) => ({ repositoryId: w.repoId, query: 'parse manifest' }) },
  { name: 'search code without symbols', tool: 'search', args: (w) => ({ repositoryId: w.repoId, query: 'parse manifest', symbols: false }) },
  {
    name: 'search everywhere',
    tool: 'search',
    // Retrier and Retrier.retry (src/retry.ts) tie in the symbol keyword leg (#623: then by path, start line).
    args: () => ({ everywhere: true, query: 'upload' }),
  },
  { name: 'find_symbols one name in three files', tool: 'find_symbols', args: (w) => ({ repositoryId: w.repoId, query: 'parse' }) },
  { name: 'find_symbols by meaning and kind', tool: 'find_symbols', args: (w) => ({ repositoryId: w.repoId, query: 'upload a chunk', kind: 'function' }) },
  { name: 'graph vault communities', tool: 'graph', args: (w) => ({ vaultId: w.vaultId }) },
  { name: 'graph repository communities', tool: 'graph', args: (w) => ({ repositoryId: w.repoId }) },
  {
    name: 'graph every node',
    tool: 'graph',
    args: (w) => ({ vaultId: w.vaultId, repositoryId: w.repoId, aggregate: 'none' }),
  },
  {
    name: 'graph neighbours',
    tool: 'graph',
    args: (w) => ({ vaultId: w.vaultId, repositoryId: w.repoId, neighborsOf: 'index', depth: 2 }),
  },
  { name: 'browse_vault root', tool: 'browse_vault', args: (w) => ({ vaultId: w.vaultId }) },
  {
    name: 'browse_vault subtree with fields',
    tool: 'browse_vault',
    args: (w) => ({ vaultId: w.vaultId, recursive: true, fields: ['path', 'title', 'type', 'name', 'tags', 'updatedAt'] }),
  },
  { name: 'browse_repository', tool: 'browse_repository', args: (w) => ({ repositoryId: w.repoId }) },
  { name: 'browse_repository folder', tool: 'browse_repository', args: (w) => ({ repositoryId: w.repoId, path: 'src' }) },
  ...NOTES.map((n): Question => ({ name: `read_note ${n.path}`, tool: 'read_note', args: (w) => ({ vaultId: w.vaultId, path: n.path }) })),
  ...FILES.map((f): Question => ({ name: `read_file ${f.path}`, tool: 'read_file', args: (w) => ({ repositoryId: w.repoId, path: f.path }) })),
  { name: 'repository_status', tool: 'repository_status', args: (w) => ({ repositoryId: w.repoId }) },
]

describe('read tools answer deterministically (#473)', () => {
  // One database's ids sort the same way every time: this half catches randomness inside the process, not id dependence.
  describe('same index, same process: the same bytes', () => {
    for (const q of QUESTIONS) {
      it(q.name, async () => {
        const first = await ask(A, q.tool, q.args(A))
        expect(JSON.parse(first).isError, first.slice(0, 400)).toBe(false)
        expect(await ask(A, q.tool, q.args(A))).toBe(first)
      })
    }
  })

  describe('another database, rows in reverse physical and id order: the same bytes once ids and times are masked', () => {
    for (const q of QUESTIONS) {
      const test = q.differs ? it.fails : it
      test(`${q.name}${q.differs ? ` (differs on dev: ${q.differs})` : ''}`, async () => {
        const other = mask(B, await ask(B, q.tool, q.args(B)))
        expect(other).toBe(mask(A, await ask(A, q.tool, q.args(A))))
      })
    }

    it('every allowlisted time key is masked in some answer (no stale allowlist entry)', async () => {
      const keys = new Set<string>()
      for (const q of QUESTIONS) for (const key of answerTimes(await ask(A, q.tool, q.args(A))).values()) keys.add(key)
      expect([...keys].sort()).toEqual([...TIME_KEYS].sort())
    })
  })

  // The graph cases above mixed three causes; each is pinned here on its own, independent of id order. A fixed
  // one stays as a plain case.
  describe('known differences, one per issue', () => {
    /** The rows of one edge kind, as names, an undirected row's ends sorted, the rows sorted. */
    const rows = async (w: World, args: Args): Promise<string[]> => {
      const answer = JSON.parse(mask(w, await ask(w, 'graph', { aggregate: 'none', ...args }))) as { structuredContent: { edges: Array<Record<string, unknown>> } }
      return answer.structuredContent.edges
        .map(({ from, to, ...rest }) => {
          const ends = [JSON.stringify(from), JSON.stringify(to)]
          return JSON.stringify({ ...rest, ends: rest.directed ? ends : ends.sort() })
        })
        .sort()
    }

    it(`semantic edges are the same whatever order the nodes were embedded in (${SEMANTIC_HISTORY})`, async () => {
      const args = (w: World) => ({ vaultId: w.vaultId, repositoryId: w.repoId, edgeTypes: ['semantic'] })
      expect(await rows(B, args(B))).toEqual(await rows(A, args(A)))
    })

    it(`an import pushed before the file it imports resolves once that file arrives (#1008)`, async () => {
      const args = (w: World) => ({ repositoryId: w.repoId, edgeTypes: ['extracted'] })
      expect(await rows(B, args(B))).toEqual(await rows(A, args(A)))
    })
  })
})
