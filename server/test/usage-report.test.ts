// The opt-in usage report (#678): what agents did on this instance, with no
// content kept. Off by default, and then no row is written. On: one row per
// MCP call (tool, profile, hashed token, account, scope ids, response tokens,
// latency, outcome, retrieval mode) and, for a search, a salted hash of the
// normalised query with its length, never its text; hits and reads as ids,
// never paths or text. An account sees only its own usage; an instance admin
// sees instance-wide aggregates with no account, note id or path in them.
// Raw rows are kept 7 days, then rolled up per day for 30.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { sql } from '../src/db/client.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
type Json = Record<string, unknown>

/** Text that must never reach a usage row: note bodies, a path segment, the queries. */
const BODY_MARK = 'zebraquartzbody'
const PATH_MARK = 'okapimarker'
const FOUND_QUERY = 'pelican lighthouse'
const MISSING_QUERY = 'xylophonequasar nonexistentterm'

let app: FastifyInstance
let baseUrl: string
const clients: Client[] = []

interface Account {
  id: string
  cookie: string
  vaultId: string
  admin: Client
  token: string
}
let owner: Account
let other: Account

async function rest(cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: Args) {
  return app.inject({ method, url, headers: { cookie }, ...(body ? { body } : {}) })
}

async function ok(cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: Args): Promise<Json> {
  const res = await rest(cookie, method, url, body)
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`)
  return res.json<Json>()
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'usage-report-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return client
}

async function mint(cookie: string, body: Args): Promise<{ client: Client; token: string }> {
  const minted = await ok(cookie, 'POST', '/api/mcp-connections', body)
  const token = minted.token as string
  return { client: await connect(token), token }
}

async function call(client: Client, name: string, args: Args): Promise<{ isError: boolean; json: Json }> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  const content = (Array.isArray(result.content) ? result.content : []) as Array<{ text?: string }>
  const text = content[0]?.text ?? ''
  return { isError: result.isError === true, json: text.startsWith('{') ? (JSON.parse(text) as Json) : { text } }
}

async function account(role: 'owner' | 'admin' | 'member', name: string): Promise<Account> {
  const user = await createActiveUser({ role })
  const cookie = await loginCookie(app, user.email)
  const vaultId = (await ok(cookie, 'POST', '/api/vaults', { name })).id as string
  const { client, token } = await mint(cookie, { name: `${name}-admin`, scope: 'account', access: 'admin', profile: 'admin' })
  return { id: user.id, cookie, vaultId, admin: client, token }
}

async function createNote(who: Account, name: string, body: string): Promise<string> {
  const created = await call(who.admin, 'create_note', { vaultId: who.vaultId, type: 'docs', name, body })
  expect(created.isError, JSON.stringify(created.json)).toBe(false)
  return created.json.id as string
}

/** Rows in the usage tables, after a report (which first writes the queued calls). */
async function usageRows(): Promise<number> {
  await report(owner.cookie)
  const [row] = await sql<Array<{ n: number }>>`SELECT (SELECT count(*) FROM usage_events)::int + (SELECT count(*) FROM usage_daily)::int AS n`
  return row!.n
}

/** Every stored usage row of every usage table, as text. */
async function storedText(): Promise<string> {
  await report(owner.cookie)
  const rows = await sql<Array<{ t: string }>>`
    SELECT row_to_json(e)::text AS t FROM usage_events e
    UNION ALL SELECT row_to_json(d)::text FROM usage_daily d`
  return rows.map((r) => r.t).join('\n')
}

/** The report; it first writes the queued calls and prunes rows past the retention. */
async function report(cookie: string, scope?: 'instance'): Promise<Json> {
  return ok(cookie, 'GET', `/api/usage/report${scope ? `?scope=${scope}` : ''}`)
}

async function setEnabled(cookie: string, enabled: boolean) {
  return rest(cookie, 'PUT', '/api/usage/settings', { enabled })
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  owner = await account('owner', 'usage-owner')
  other = await account('member', 'usage-other')
}, 60_000)

afterAll(async () => {
  if (owner) await setEnabled(owner.cookie, false)
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('usage report (#678)', () => {
  it('is off by default, and then a call writes no row', async () => {
    expect(await ok(owner.cookie, 'GET', '/api/usage/settings')).toEqual({ enabled: false })
    const before = await usageRows()
    await createNote(owner, 'disabled-probe', `${BODY_MARK} while off`)
    await call(owner.admin, 'search', { vaultId: owner.vaultId, query: MISSING_QUERY })
    await call(owner.admin, 'read_note', { vaultId: owner.vaultId, path: 'docs/disabled-probe' })
    expect(await usageRows()).toBe(before)
    const off = await report(owner.cookie)
    expect(off).toMatchObject({ enabled: false })
  })

  it('only the instance owner turns it on or off', async () => {
    const admin = await createActiveUser({ role: 'admin' })
    const adminCookie = await loginCookie(app, admin.email)
    expect((await setEnabled(adminCookie, true)).statusCode).toBe(403)
    expect((await setEnabled(other.cookie, true)).statusCode).toBe(403)
    expect(await ok(owner.cookie, 'GET', '/api/usage/settings')).toEqual({ enabled: false })
    const on = await setEnabled(owner.cookie, true)
    expect(on.statusCode, on.body).toBe(200)
    expect(on.json()).toEqual({ enabled: true })
  })

  it('records each call with no note text, path or query text in any row', async () => {
    const noteId = await createNote(owner, `${PATH_MARK}-lighthouse`, `The ${FOUND_QUERY} keeper. ${BODY_MARK}`)
    await flushEmbeddings()
    const hit = await call(owner.admin, 'search', { vaultId: owner.vaultId, query: FOUND_QUERY })
    expect(hit.isError).toBe(false)
    await call(owner.admin, 'search', { vaultId: owner.vaultId, query: MISSING_QUERY })
    await call(owner.admin, 'read_note', { vaultId: owner.vaultId, path: `docs/${PATH_MARK}-lighthouse` })
    await call(owner.admin, 'read_note', { vaultId: owner.vaultId, path: 'docs/no-such-note' })

    const stored = await storedText()
    for (const mark of [BODY_MARK, PATH_MARK, 'pelican', 'lighthouse', 'xylophonequasar', owner.token]) {
      expect(stored, mark).not.toContain(mark)
    }
    const rows = await sql<Array<Json>>`
      SELECT tool, profile::text, token, account_id, vault_id, outcome, response_tokens, latency_ms, retrieval_mode,
             query_hash, query_length, query_lang, filters, hit_ids, target_id
      FROM usage_events WHERE account_id = ${owner.id} ORDER BY id`
    const tools = rows.map((r) => r.tool)
    expect(tools).toEqual(['create_note', 'search', 'search', 'read_note', 'read_note'])
    for (const r of rows) {
      expect(r).toMatchObject({ profile: 'admin', account_id: owner.id, vault_id: owner.vaultId })
      expect(r.token).toMatch(/^[0-9a-f]{16}$/)
      expect(r.response_tokens as number).toBeGreaterThan(0)
      expect(r.latency_ms as number).toBeGreaterThanOrEqual(0)
    }
    const [, found, missing, read, notFound] = rows
    expect(found).toMatchObject({ outcome: 'ok', query_length: FOUND_QUERY.length, query_lang: 'latin', filters: {} })
    expect(found!.query_hash).toMatch(/^[0-9a-f]{16}$/)
    expect(found!.hit_ids).toContain(noteId)
    expect(missing).toMatchObject({ outcome: 'no_match', hit_ids: [] })
    expect(found!.retrieval_mode).toEqual(expect.any(String))
    expect(read).toMatchObject({ outcome: 'ok', target_id: noteId })
    expect(notFound).toMatchObject({ outcome: 'NOT_FOUND', target_id: null })
  })

  it('counts zero-result searches by query hash, and searches whose hits were not read', async () => {
    await call(owner.admin, 'search', { vaultId: owner.vaultId, query: `  ${MISSING_QUERY.toUpperCase()} ` })
    await call(owner.admin, 'search', { vaultId: owner.vaultId, query: FOUND_QUERY, limit: 5 })
    for (let i = 0; i < 6; i++) await call(owner.admin, 'list_vaults', {})
    const r = await report(owner.cookie)
    const searches = r.searches as Json
    expect(searches).toMatchObject({ total: 4, zero_result: 2, with_hits: 2, no_useful_hit: 1, useful_within_calls: 5 })
    // The same query, normalised (case, spaces), is one hash.
    const zero = searches.zero_result_queries as Json[]
    expect(zero).toEqual([expect.objectContaining({ count: 2, length: MISSING_QUERY.length, language: 'latin', tool: 'search' })])
    const unread = searches.no_useful_hit_queries as Json[]
    expect(unread).toEqual([expect.objectContaining({ count: 1, length: FOUND_QUERY.length, filters: { limit: 5 } })])
    expect(JSON.stringify(r)).not.toContain('pelican')
  })

  it('lists the notes never read by id and path, and tokens and calls per tool and per session', async () => {
    const unreadId = await createNote(owner, 'never-opened', 'nobody reads this')
    const r = await report(owner.cookie)
    const never = r.never_read as { count: number; notes: Array<{ id: string; path: string; vault_id: string }> }
    expect(never.notes).toContainEqual({ id: unreadId, vault_id: owner.vaultId, path: 'docs/never-opened' })
    expect(never.notes.map((n) => n.path)).not.toContain(`docs/${PATH_MARK}-lighthouse`)
    expect(never.count).toBe(never.notes.length)
    const tools = r.tools as Array<Json>
    const search = tools.find((t) => t.tool === 'search')
    expect(search).toMatchObject({ calls: 4, zero_results: 2, errors: 0 })
    expect(search!.tokens as number).toBeGreaterThan(0)
    expect(tools.find((t) => t.tool === 'read_note')).toMatchObject({ calls: 2, errors: 1 })
    type Session = { token: string; calls: number; tokens: number; tools: Record<string, { calls: number; tokens: number }> }
    const sessions = r.sessions as { count: number; latest: Session[] }
    expect(sessions.count).toBe(1)
    expect(sessions.latest[0]!.token).toMatch(/^[0-9a-f]{16}$/)
    expect(sessions.latest[0]!.tools.search!.calls).toBe(4)
    expect(sessions.latest[0]!.calls).toBe((r.totals as Json).calls)
  })

  it('records a client-reported fallback to local tools with the notes read just before it', async () => {
    const before = await report(owner.cookie)
    expect(before.fallbacks).toMatchObject({ reported: 0, populated: false })
    const readId = await createNote(owner, 'before-fallback', 'read before grep')
    await call(owner.admin, 'read_note', { vaultId: owner.vaultId, path: 'docs/before-fallback' })
    // The hook: a JSON-RPC notification on the MCP endpoint (no tools/list cost); no known client sends it yet.
    await owner.admin.notification({ method: 'notifications/elara/client_event', params: { event: 'local_fallback' } })
    const r = await report(owner.cookie)
    expect(r.fallbacks).toMatchObject({ reported: 1, populated: true })
    expect((r.fallbacks as Json).notes_read_before).toEqual([{ id: readId, vault_id: owner.vaultId, path: 'docs/before-fallback', count: 1 }])
  })

  it('separates accounts: each sees only its own usage, the instance view only aggregates', async () => {
    const otherNote = await createNote(other, `${PATH_MARK}-other`, 'the other account')
    await call(other.admin, 'list_teams', {})
    const mine = await report(owner.cookie)
    const theirs = await report(other.cookie)
    const toolsOf = (r: Json) => (r.tools as Json[]).map((t) => t.tool)
    expect(toolsOf(mine)).not.toContain('list_teams')
    expect(toolsOf(theirs).sort()).toEqual(['create_note', 'list_teams'])
    expect(JSON.stringify(mine)).not.toContain(otherNote)
    expect(JSON.stringify(theirs)).not.toContain(owner.vaultId)
    expect((theirs.searches as Json).total).toBe(0)
    expect((theirs.never_read as Json).notes).toEqual([{ id: otherNote, vault_id: other.vaultId, path: `docs/${PATH_MARK}-other` }])

    // The instance view is for instance admins, and holds no account, note id or path.
    expect((await rest(other.cookie, 'GET', '/api/usage/report?scope=instance')).statusCode).toBe(403)
    const instance = await report(owner.cookie, 'instance')
    expect(instance.scope).toBe('instance')
    const ownerTotal = (mine.totals as Json).calls as number
    const otherTotal = (theirs.totals as Json).calls as number
    expect((instance.totals as Json).calls).toBe(ownerTotal + otherTotal)
    const text = JSON.stringify(instance)
    for (const secret of [owner.id, other.id, owner.vaultId, other.vaultId, otherNote, PATH_MARK]) expect(text).not.toContain(secret)
    expect(instance.never_read).toEqual({ count: expect.any(Number) })

    // Over MCP: the owner's token answers its account; a member's token is refused the instance view.
    const own = await call(owner.admin, 'usage_report', {})
    expect(own.isError, JSON.stringify(own.json)).toBe(false)
    expect(own.json).toMatchObject({ enabled: true, scope: 'account' })
    expect(JSON.stringify(own.json)).not.toContain(otherNote)
    const refused = await call(other.admin, 'usage_report', { scope: 'instance' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.json)).toMatch(/PERMISSION_REQUIRED/)
  })

  it('lists usage_report only on admin-profile tokens', async () => {
    const listed = async (profile: string) => {
      const { client } = await mint(owner.cookie, { name: `usage-${profile}`, scope: 'account', access: 'admin', profile })
      resetRateLimits()
      const names = (await client.listTools()).tools.map((t) => t.name)
      return { names, client }
    }
    expect((await listed('reader')).names).not.toContain('usage_report')
    const writer = await listed('writer')
    expect(writer.names).not.toContain('usage_report')
    expect((await call(writer.client, 'usage_report', {})).isError).toBe(true)
    expect((await listed('admin')).names).toContain('usage_report')
  })

  it('rolls raw rows past 7 days into daily totals and deletes rollups past 30 days', async () => {
    const calls = ((await report(owner.cookie)).totals as Json).calls as number
    expect(calls).toBeGreaterThan(0)
    await sql`UPDATE usage_events SET at = now() - interval '8 days' WHERE account_id = ${owner.id}`
    // Totals per tool still count the rolled-up calls; the 7-day detail is empty.
    const after = await report(owner.cookie)
    expect((after.totals as Json).calls).toBe(calls)
    expect((after.searches as Json).total).toBe(0)
    const [raw] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM usage_events WHERE account_id = ${owner.id}`
    expect(raw!.n).toBe(0)
    const [daily] = await sql<Array<{ n: number }>>`SELECT sum(calls)::int AS n FROM usage_daily WHERE account_id = ${owner.id}`
    expect(daily!.n).toBe(calls)

    await sql`UPDATE usage_daily SET day = day - 31 WHERE account_id = ${owner.id}`
    expect(((await report(owner.cookie)).totals as Json).calls).toBe(0)
    const [left] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM usage_daily WHERE account_id = ${owner.id}`
    expect(left!.n).toBe(0)
    expect(await storedText()).not.toContain(BODY_MARK)
  })

  it('writes nothing once turned off again', async () => {
    expect((await setEnabled(owner.cookie, false)).statusCode).toBe(200)
    const before = await usageRows()
    await call(owner.admin, 'search', { vaultId: owner.vaultId, query: MISSING_QUERY })
    expect(await usageRows()).toBe(before)
  })
})
