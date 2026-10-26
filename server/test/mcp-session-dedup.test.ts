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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db, sql } from '../src/db/client.js'
import { repositoryShares } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote, updateNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
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
  const files = [{ path: 'src/store.ts', content: STORE_TS }]
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
    const target = { path: 'src/store.ts', session_id: session, targets: [{ symbol: 'Store.load' }] }
    // Idle for less than the window: still remembered, and the call keeps it alive.
    await sql`UPDATE mcp_sessions SET used_at = now() - interval '29 minutes' WHERE session_id = ${session}`
    expect(parts(await readFile(target))[0]!.same_as).toEqual(expect.objectContaining({ call: 1 }))
    await sql`UPDATE mcp_sessions SET used_at = now() - interval '31 minutes' WHERE session_id = ${session}`
    const expired = await readFile(target)
    expect(expired.json.call).toBe(3)
    expect(parts(expired)[0]!.text).toContain('load(key: string)')
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
})
