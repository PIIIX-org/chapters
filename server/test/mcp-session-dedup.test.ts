// #683 (ADR-004 §2.1, §2.9): per-session de-duplication. read_note and
// read_file take an optional `session_id` (the agent's own, 8-64
// characters). Under it Elara remembers which passages it sent: a body page,
// each `targets` part, the outline, read_file's symbol list. A passage the
// session already got comes back as `same_as: {call, loc, rev | hash}`: the
// call that sent it (every session answer says its `call`), the lines there
// (`path#La-Lb`, or the path for an outline or a symbol list) and that call's
// version. A passage repeats when the session got the same document version
// with lines covering it, or the same text of the document at any version; a
// changed passage is sent in full, as is one whose reference would be longer.
//
// The memory is per token and session id (`mcp_sessions`, migration 0056):
// another session id, another token of the same account and another account
// get full text. It expires after SESSION_IDLE_MINUTES without a call, and a
// permission change (instance_state.permission_epoch, #680) voids it. Without
// `session_id` a read answers in full, byte for byte as before #683: what an
// agent whose context was cut sends to get the text back.
import { randomUUID } from 'node:crypto'
import { readFile as readDisk } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { MAX_PASSAGES, MAX_SESSIONS, openSession, rememberPassages } from '../src/cache/session.js'
import { db, sql } from '../src/db/client.js'
import { repositoryShares } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote, updateNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Json = Record<string, unknown>
interface Result {
  json: Json
  /** Every content block's text: the JSON, then read_note's body. */
  texts: string[]
}

let app: FastifyInstance
let baseUrl: string
let cookie: string
let vaultId: string
let repoId: string
let guestId: string
let owner: Client
let ownerAgain: Client
let guest: Client
const clients: Client[] = []

const GUIDE = [
  '# Setup',
  '',
  'Install the command line tool with your package manager, then run the setup wizard once on every machine you use.',
  '',
  '## Linux',
  '',
  'Run `apt install elara-cli`, then `elara setup --user` to write the configuration file into your home directory.',
  '',
  '# Usage',
  '',
  'Run `elara sync` in a project folder to index it; the first run takes a few minutes on a large repository.',
  '',
].join('\n')

const STORE_TS = [
  '/** A key-value store kept in memory, with a write log to replay after a restart. */',
  'export class Store {',
  '  private readonly items = new Map<string, string>()',
  '  private readonly log: string[] = []',
  '',
  '  /** Saves `value` under `key`, replacing what was there, and logs the write. */',
  '  save(key: string, value: string): void {',
  '    this.items.set(key, value)',
  '    this.log.push(`save ${key} ${value.length}`)',
  '  }',
  '',
  '  /** The value under `key`, or undefined when nothing was saved there. */',
  '  load(key: string): string | undefined {',
  '    return this.items.get(key)',
  '  }',
  '}',
  '',
].join('\n')

/** The note's `Setup > Linux` section (lines 10-13: the frontmatter has 5 lines) and the file's `Store.save` (lines 7-10). */
const LINUX = GUIDE.split('\n').slice(4, 8).join('\n') + '\n'
const SAVE = STORE_TS.split('\n').slice(6, 10).join('\n') + '\n'

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'session-dedup-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return client
}

async function mint(name: string, c = cookie): Promise<Client> {
  const res = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: c }, body: { name, scope: 'account' } })
  return mcpClient(res.json<{ token: string }>().token)
}

async function call(client: Client, tool: string, args: Json): Promise<Result & { isError: boolean }> {
  resetRateLimits()
  const result = await client.callTool({ name: tool, arguments: args })
  const texts = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '')
  let json: Json
  try {
    json = JSON.parse(texts[0]!) as Json
  } catch {
    json = { text: texts[0] }
  }
  return { isError: result.isError === true, json, texts }
}

async function ok(client: Client, tool: string, args: Json): Promise<Result> {
  const r = await call(client, tool, args)
  expect(r.isError, `${tool} ${JSON.stringify(args)}: ${JSON.stringify(r.json).slice(0, 300)}`).toBe(false)
  return r
}

const readNote = (args: Json, client = owner) => ok(client, 'read_note', { vaultId, ...args })
const readFile = (args: Json, client = owner) => ok(client, 'read_file', { repositoryId: repoId, ...args })
const parts = (r: Result) => r.json.targets as Json[]

let sessions = 0
/** A fresh session id. */
const newSession = () => `session-${++sessions}-${Date.now()}`

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const ownerUser = await createActiveUser()
  cookie = await loginCookie(app, ownerUser.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'session vault' } })).json<{ id: string }>().id
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'session-repo', ingestionMethod: 'agent_push' } })).json<{
    id: string
  }>().id
  owner = await mint('session-owner')
  ownerAgain = await mint('session-owner-again')
  const guestUser = await createActiveUser()
  guestId = guestUser.id
  guest = await mint('session-guest', await loginCookie(app, guestUser.email))
  await db.insert(repositoryShares).values({ repositoryId: repoId, granteeType: 'user', granteeId: guestId })

  await createNote(vaultId, { path: 'docs/guide', frontmatter: { title: 'Guide' }, body: GUIDE })
  const files = [
    { path: 'src/store.ts', content: STORE_TS },
    { path: 'src/big.ts', content: Array.from({ length: 80 }, (_, i) => `export const value${i} = 'a string literal long enough to make this line about seventy'\n`).join('') },
  ]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
}, 180_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('without session_id (#683): byte for byte as before', () => {
  it('answers read_note and read_file as dev does', async () => {
    // The frontmatter (its `timestamp`) and `indexed` come from the store; every other byte is fixed.
    const body = await readNote({ path: 'docs/guide' })
    const { frontmatter, indexed } = body.json
    expect(body.texts).toEqual([
      `{"path":"docs/guide","rev":1,"frontmatter":${JSON.stringify(frontmatter)},"indexed":${indexed},"body_start_line":6,"total_lines":16,"body":{"in":"content[1]"},"truncated":false}`,
      GUIDE,
    ])
    const target = await readNote({ path: 'docs/guide', targets: [{ heading: 'Setup > Linux' }] })
    expect(target.texts).toEqual([
      `{"path":"docs/guide","rev":1,"body_start_line":6,"total_lines":16,"targets":[{"heading":"Setup > Linux","lines":[10,13],"text":${JSON.stringify(LINUX)}}],"truncated":false}`,
    ])
    const file = await readFile({ path: 'src/store.ts', targets: [{ lines: '7-10' }] })
    const { tree, hash } = file.json
    expect(file.texts).toEqual([
      `{"path":"src/store.ts","language":"typescript","tree":${JSON.stringify(tree)},"hash":${JSON.stringify(hash)},"total_lines":16,"targets":[{"lines":[7,10],"text":${JSON.stringify(SAVE)}}],"truncated":false}`,
    ])
  })

  it('answers the same after reads under a session, with no `call` or `same_as`', async () => {
    const reads: Array<() => Promise<Result>> = [
      () => readNote({ path: 'docs/guide' }),
      () => readNote({ path: 'docs/guide', outline: true }),
      () => readFile({ path: 'src/store.ts' }),
      () => readFile({ path: 'src/store.ts', targets: [{ symbol: 'Store.save' }] }),
    ]
    const before = [] as Result[]
    for (const read of reads) before.push(await read())
    const session = newSession()
    await readNote({ path: 'docs/guide', session_id: session })
    await readFile({ path: 'src/store.ts', session_id: session })
    for (const [i, read] of reads.entries()) {
      const after = await read()
      expect(after.texts, `read ${i}`).toEqual(before[i]!.texts)
      expect(after.texts[0]).not.toMatch(/"call"|"same_as"/)
    }
  })
})

describe('session_id (#683)', () => {
  it('answers a passage the session already got with `same_as`: call, lines and version', async () => {
    const session = newSession()
    const whole = await readFile({ path: 'src/store.ts', session_id: session })
    expect(whole.json.call).toBe(1)
    expect(whole.json.content).toBe(STORE_TS)
    const hash = whole.json.hash as string
    // A target inside the whole read: the lines of call 1 in its numbering, at its version.
    const save = await readFile({ path: 'src/store.ts', session_id: session, targets: [{ symbol: 'Store.save' }, { lines: '2' }] })
    expect(save.json.call).toBe(2)
    expect(parts(save)).toEqual([
      { symbol: 'Store.save', lines: [7, 10], same_as: { call: 1, loc: 'src/store.ts#L7-L10', hash } },
      // Shorter than its reference: sent as text.
      { lines: [2, 2], text: 'export class Store {\n' },
    ])
    // The whole file again: the content and the symbol list are references, nothing is cut.
    const again = await readFile({ path: 'src/store.ts', session_id: session })
    expect(again.json).toMatchObject({
      call: 3,
      content: { same_as: { call: 1, loc: 'src/store.ts#L1-L16', hash } },
      symbols: { same_as: { call: 1, loc: 'src/store.ts', hash } },
      truncated: false,
    })
    expect(again.texts.join('\n').length).toBeLessThan(whole.texts.join('\n').length / 2)
    // The outline twice: the second is a reference to the first.
    const outline = await readFile({ path: 'src/store.ts', session_id: session, outline: true })
    expect(outline.json.outline).toEqual(expect.any(Array))
    const outlineAgain = await readFile({ path: 'src/store.ts', session_id: session, outline: true })
    expect(outlineAgain.json.outline).toEqual({ same_as: { call: 4, loc: 'src/store.ts', hash } })

    // A note: the body, then a section inside it, then the body again.
    const noteSession = newSession()
    const body = await readNote({ path: 'docs/guide', session_id: noteSession })
    expect(body.json.call).toBe(1)
    expect(body.texts[1]).toBe(GUIDE)
    const rev = body.json.rev as number
    const section = await readNote({ path: 'docs/guide', session_id: noteSession, targets: [{ heading: 'Setup > Linux' }] })
    expect(parts(section)).toEqual([{ heading: 'Setup > Linux', lines: [10, 13], same_as: { call: 1, loc: 'docs/guide#L10-L13', rev } }])
    const bodyAgain = await readNote({ path: 'docs/guide', session_id: noteSession })
    expect(bodyAgain.json).toMatchObject({ call: 3, frontmatter: { title: 'Guide' }, body: { same_as: { call: 1, loc: 'docs/guide#L6-L16', rev } }, truncated: false })
    expect(bodyAgain.texts).toHaveLength(1)
  })

  it('sends a changed passage in full, and an unchanged one moved by the change as a reference to where it was', async () => {
    await createNote(vaultId, { path: 'docs/changing', body: GUIDE })
    const session = newSession()
    const first = await readNote({ path: 'docs/changing', session_id: session, targets: [{ heading: 'Setup' }, { heading: 'Usage' }] })
    const rev = first.json.rev as number
    expect(parts(first).map((p) => p.text)).toEqual([expect.any(String), expect.any(String)])
    // The setup section gains two lines: its text changes, and the usage section moves down two lines unchanged.
    await updateNote(vaultId, 'docs/changing', { body: GUIDE.replace('## Linux', 'Windows is not supported yet.\n\n## Linux') })
    const after = await readNote({ path: 'docs/changing', session_id: session, targets: [{ heading: 'Setup' }, { heading: 'Usage' }] })
    expect(after.json.rev).not.toBe(rev)
    const [setup, usage] = parts(after)
    expect(setup!.text).toContain('Windows is not supported yet.')
    expect(setup!.same_as).toBeUndefined()
    const usageBefore = parts(first)[1]!
    const [a, b] = usageBefore.lines as [number, number]
    expect(usage).toEqual({ heading: 'Usage', lines: [a + 2, b + 2], same_as: { call: 1, loc: `docs/changing#L${a}-L${b}`, rev } })
  })

  it('answers in full to another session id, another token of the account and another account', async () => {
    const session = newSession()
    await readFile({ path: 'src/store.ts', session_id: session })
    const target = { path: 'src/store.ts', targets: [{ symbol: 'Store.save' }] }
    expect(parts(await readFile({ ...target, session_id: session }))[0]!.same_as).toBeDefined()
    const full = (r: Result) => expect(parts(r)[0]).toEqual({ symbol: 'Store.save', lines: [7, 10], text: SAVE })
    full(await readFile({ ...target, session_id: newSession() }))
    full(await readFile({ ...target, session_id: session }, ownerAgain))
    full(await readFile({ ...target, session_id: session }, guest))
    // Without the session: in full, and the session still remembers.
    full(await readFile(target))
    expect(parts(await readFile({ ...target, session_id: session }))[0]!.same_as).toBeDefined()
  })

  it('forgets a session idle for SESSION_IDLE_MINUTES: full text, call numbers go on', async () => {
    const session = newSession()
    await readFile({ path: 'src/store.ts', session_id: session })
    const target = { path: 'src/store.ts', session_id: session, targets: [{ symbol: 'Store.save' }] }
    // Idle for less than the window: still remembered, and the call keeps it alive.
    await sql`UPDATE mcp_sessions SET used_at = now() - interval '29 minutes' WHERE session_id = ${session}`
    expect(parts(await readFile(target))[0]!.same_as).toEqual(expect.objectContaining({ call: 1 }))
    await sql`UPDATE mcp_sessions SET used_at = now() - interval '31 minutes' WHERE session_id = ${session}`
    const expired = await readFile(target)
    expect(expired.json.call).toBe(3)
    expect(parts(expired)[0]!.text).toBe(SAVE)
    // What the expired session sent before is forgotten; what it sends now is remembered.
    expect(parts(await readFile(target))[0]!.same_as).toEqual(expect.objectContaining({ call: 3 }))
  })

  it('forgets everything on a permission change (#680 permission epoch)', async () => {
    const session = newSession()
    await readFile({ path: 'src/store.ts', session_id: session }, guest)
    const target = { path: 'src/store.ts', session_id: session, targets: [{ symbol: 'Store.save' }] }
    expect(parts(await readFile(target, guest))[0]!.same_as).toBeDefined()
    // Any share change moves the epoch: here the guest's own share, removed and given back.
    await db.delete(repositoryShares).where(and(eq(repositoryShares.repositoryId, repoId), eq(repositoryShares.granteeId, guestId)))
    expect((await call(guest, 'read_file', { repositoryId: repoId, ...target })).isError).toBe(true)
    await db.insert(repositoryShares).values({ repositoryId: repoId, granteeType: 'user', granteeId: guestId })
    const after = await readFile(target, guest)
    expect(parts(after)[0]!.text).toContain('save(key: string, value: string)')
    expect(parts(after)[0]!.same_as).toBeUndefined()
  })

  it('refuses a session_id outside 8 to 64 characters', async () => {
    for (const session_id of ['short', 'x'.repeat(65)]) {
      const r = await call(owner, 'read_file', { repositoryId: repoId, path: 'src/store.ts', session_id })
      expect(r.isError).toBe(true)
      expect(JSON.stringify(r.json)).toContain('session_id')
    }
  })

  it('remembers what each page showed: a cursor page is sent in full, and later reads refer to the page that had the lines', async () => {
    const session = newSession()
    const first = await readFile({ path: 'src/big.ts', session_id: session, budget_tokens: 256 })
    const truncated = first.json.truncated as { cursor: string }
    const [, end] = first.json.lines as [number, number]
    const second = await readFile({ path: 'src/big.ts', session_id: session, budget_tokens: 256, cursor: truncated.cursor })
    expect(second.json.call).toBe(2)
    expect(second.json.lines).toEqual([end + 1, expect.any(Number)])
    const hash = first.json.hash
    const targets = await readFile({ path: 'src/big.ts', session_id: session, targets: [{ lines: '2-4' }, { lines: `${end + 2}-${end + 4}` }] })
    expect(parts(targets)).toEqual([
      { lines: [2, 4], same_as: { call: 1, loc: 'src/big.ts#L2-L4', hash } },
      { lines: [end + 2, end + 4], same_as: { call: 2, loc: `src/big.ts#L${end + 2}-L${end + 4}`, hash } },
    ])
  })

  it('keeps at most MAX_PASSAGES per session, the newest, and MAX_SESSIONS per token', async () => {
    const [{ id: connectionId }] = (await sql`SELECT id FROM mcp_connections WHERE name = 'session-owner-again'`) as unknown as [{ id: string }]
    const doc = randomUUID()
    for (let call = 1; call <= 3; call++) {
      const session = await openSession(connectionId, 'cap-passages', doc)
      const passages = Array.from({ length: 200 }, (_, k) => ({ kind: 'text' as const, hash: `${call}-${k}`, version: '1', first: k + 1, last: k + 1 }))
      await rememberPassages(session, passages)
    }
    const held = (await sql`SELECT call, count(*)::int AS n FROM mcp_session_passages WHERE connection_id = ${connectionId} AND session_id = 'cap-passages' GROUP BY call ORDER BY call`) as unknown as Array<{ call: number; n: number }>
    expect(held.reduce((n, r) => n + r.n, 0)).toBe(MAX_PASSAGES)
    expect(held.at(-1)).toEqual({ call: 3, n: 200 })
    for (let i = 0; i < MAX_SESSIONS + 4; i++) await openSession(connectionId, `cap-session-${i}`, doc)
    const [{ n }] = (await sql`SELECT count(*)::int AS n FROM mcp_sessions WHERE connection_id = ${connectionId}`) as unknown as [{ n: number }]
    expect(n).toBe(MAX_SESSIONS)
  })
})

/**
 * The scripted session (#683 done-when): twelve calls an agent makes on the
 * chapters repository's own files (search, a whole read, an outline, targets,
 * re-reads), once without and once with a session. The session costs fewer
 * tokens (characters / 4 over every content block, as the benchmark counts),
 * and every session answer, its references replaced by the lines of the
 * calls they name, is the no-session answer byte for byte.
 */
describe('scripted session on the chapters files (#683)', () => {
  const REPO_ROOT = join(import.meta.dirname, '..', '..')
  const FILES = ['server/src/mcp/rate-limit.ts', 'server/src/mcp/routes.ts', 'server/src/mcp/instructions.ts']
  let fixtureRepo: string
  let fixtureVault: string

  beforeAll(async () => {
    fixtureRepo = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'chapters-fixture', ingestionMethod: 'agent_push' } })).json<{
      id: string
    }>().id
    fixtureVault = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'chapters fixture' } })).json<{ id: string }>().id
    const files = await Promise.all(FILES.map(async (path) => ({ path, content: await readDisk(join(REPO_ROOT, path), 'utf8') })))
    await syncRepositoryFiles(fixtureRepo, files, FILES)
    await createNote(fixtureVault, { path: 'agents/brief', body: await readDisk(join(REPO_ROOT, 'docs/agents/brief.md'), 'utf8') })
    await flushExtraction()
    await flushEmbeddings()
  }, 180_000)

  /** Lines a..b of `text` whose first line is `first`, each with its `\n` (text/targets.ts `wholeLines`). */
  const linesOf = (text: string, first: number, a: number, b: number) =>
    text
      .split(/(?<=\n)/)
      .slice(a - first, b - first + 1)
      .join('')

  /** The text call `ref.call` sent of the lines `ref.loc` names. */
  function referenced(sent: Result[], ref: { call: number; loc: string }): string {
    const answer = sent[ref.call - 1]!
    const [, a, b] = /#L(\d+)(?:-L(\d+))?$/.exec(ref.loc)!.map(Number) as [number, number, number]
    const end = Number.isNaN(b) ? a : b
    const { json } = answer
    const pieces: Array<[number, string]> = []
    const at = (json.lines as [number, number] | undefined)?.[0]
    if (typeof json.content === 'string') pieces.push([at ?? 1, json.content])
    if (json.body && typeof json.body === 'object' && 'in' in json.body) pieces.push([at ?? (json.body_start_line as number), answer.texts[1]!])
    for (const part of (json.targets as Json[] | undefined) ?? []) if (typeof part.text === 'string') pieces.push([(part.lines as number[])[0]!, part.text])
    const piece = pieces.find(([first, text]) => first <= a && first + text.split(/(?<=\n)/).length - 1 >= end)
    expect(piece, `call ${ref.call} sent ${ref.loc}`).toBeDefined()
    return linesOf(piece![1], piece![0], a, end)
  }

  /** A session answer with its references replaced by what they name, and without `call`: the texts of the no-session answer. */
  function expand(sent: Result[], answer: Result): string[] {
    const texts = [...answer.texts]
    const json: Json = {}
    for (const [key, value] of Object.entries(answer.json)) {
      if (key === 'call') continue
      const same = value && typeof value === 'object' && 'same_as' in value ? (value.same_as as { call: number; loc: string }) : null
      if (!same) json[key] = value
      else if (key === 'outline' || key === 'symbols') json[key] = sent[same.call - 1]!.json[key]
      else if (key === 'body') {
        json[key] = { in: 'content[1]' }
        texts.splice(1, 0, referenced(sent, same))
      } else json[key] = referenced(sent, same)
    }
    if (Array.isArray(json.targets)) {
      json.targets = (json.targets as Json[]).map((part) =>
        Object.fromEntries(Object.entries(part).map(([k, v]) => (k === 'same_as' ? ['text', referenced(sent, v as { call: number; loc: string })] : [k, v]))),
      )
    }
    texts[0] = JSON.stringify(json)
    return texts
  }

  it('costs fewer tokens with the same answers', async () => {
    const outline = await ok(owner, 'read_note', { vaultId: fixtureVault, path: 'agents/brief', outline: true })
    const heading = (outline.json.outline as Json[]).find((e) => typeof e.heading === 'string' && e.heading.includes('>'))!.heading as string
    const script: Array<[string, Json]> = [
      ['search', { repositoryId: fixtureRepo, query: 'rate limit per connection' }],
      ['read_file', { repositoryId: fixtureRepo, path: 'server/src/mcp/rate-limit.ts' }],
      ['read_file', { repositoryId: fixtureRepo, path: 'server/src/mcp/routes.ts', outline: true }],
      ['read_file', { repositoryId: fixtureRepo, path: 'server/src/mcp/routes.ts', targets: [{ symbol: 'mcpRoutes' }] }],
      ['search', { repositoryId: fixtureRepo, query: 'retry after rate limited' }],
      ['read_file', { repositoryId: fixtureRepo, path: 'server/src/mcp/rate-limit.ts', targets: [{ symbol: 'checkRateLimit' }] }],
      ['read_file', { repositoryId: fixtureRepo, path: 'server/src/mcp/routes.ts', outline: true }],
      ['read_file', { repositoryId: fixtureRepo, path: 'server/src/mcp/routes.ts', targets: [{ lines: '27-42' }] }],
      ['read_note', { vaultId: fixtureVault, path: 'agents/brief', targets: [{ heading }] }],
      ['read_note', { vaultId: fixtureVault, path: 'agents/brief' }],
      ['read_note', { vaultId: fixtureVault, path: 'agents/brief', targets: [{ heading }] }],
      ['read_file', { repositoryId: fixtureRepo, path: 'server/src/mcp/rate-limit.ts' }],
    ]
    const tokens = (r: Result) => Math.ceil(r.texts.join('\n').length / 4)
    const run = async (session: string | null) => {
      const started = performance.now()
      const answers: Result[] = []
      for (const [tool, args] of script) answers.push(await ok(owner, tool, tool !== 'search' && session ? { ...args, session_id: session } : args))
      return { answers, ms: performance.now() - started }
    }
    const plain = await run(null)
    const session = await run(newSession())
    const reads = session.answers.filter((a) => typeof a.json.call === 'number')
    expect(reads.map((a) => a.json.call)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    for (const [i, answer] of session.answers.entries()) {
      const [tool] = script[i]!
      const sent = session.answers.filter((a) => typeof a.json.call === 'number')
      const expected = plain.answers[i]!.texts
      expect(tool === 'search' ? answer.texts : expand(sent, answer), `call ${i + 1} (${tool})`).toEqual(expected)
    }
    const totals = { plain: plain.answers.reduce((n, a) => n + tokens(a), 0), session: session.answers.reduce((n, a) => n + tokens(a), 0) }
    const perCall = session.answers.map((a, i) => `${i + 1} ${script[i]![0]} ${tokens(plain.answers[i]!)} -> ${tokens(a)}`)
    // The memory's cost per call: one statement before the answer, one after it.
    const [{ id: connectionId }] = (await sql`SELECT id FROM mcp_connections WHERE name = 'session-owner'`) as unknown as [{ id: string }]
    const rounds = 200
    const doc = randomUUID()
    let open = 0
    let remember = 0
    let ping = 0
    for (let i = 0; i < rounds; i++) {
      const t0 = performance.now()
      const s = await openSession(connectionId, 'cost-probe', doc)
      const t1 = performance.now()
      await rememberPassages(s, [0, 1, 2].map((k) => ({ kind: 'text' as const, hash: `${i}-${k}`, version: '1', first: k * 10 + 1, last: k * 10 + 9 })))
      const t2 = performance.now()
      await sql`SELECT 1`
      open += t1 - t0
      remember += t2 - t1
      ping += performance.now() - t2
    }
    console.log(
      [
        `scripted session (${script.length} calls on chapters files): without session ~${totals.plain} tokens, with ~${totals.session} (${Math.round((100 * (totals.plain - totals.session)) / totals.plain)}% fewer)`,
        `wall time: without ${Math.round(plain.ms)} ms, with ${Math.round(session.ms)} ms`,
        `memory per call (mean of ${rounds}): openSession ${(open / rounds).toFixed(2)} ms, rememberPassages (3 passages) ${(remember / rounds).toFixed(2)} ms; a SELECT 1 round trip ${(ping / rounds).toFixed(2)} ms`,
        ...perCall,
      ].join('\n'),
    )
    expect(totals.session).toBeLessThan(totals.plain)
  })
})
