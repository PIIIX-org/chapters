// Structured MCP errors (#439, ADR-004 §2.7). Before, a failed call was free
// text `Error: <message>` (or the SDK's `MCP error -32602: ...` for bad
// arguments): an agent could only regex it. Now every failed call answers
// `content[0].text` = `{"error":{code, message, retryable, retryAfterMs?,
// rule?, field?, suggestions?}}` with `isError: true` and no structuredContent
// (the SDK client validates any structuredContent against a write tool's
// outputSchema, even on an error). Suggestions come only from containers the
// caller can read, so another account's id answers the exact bytes of a
// missing one.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { notes, repositories } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
interface ErrorBody {
  code: string
  message: string
  retryable: boolean
  retryAfterMs?: number
  rule?: string
  field?: string
  suggestions?: string[]
}

const SLUG_RULE = '^[a-z0-9][a-z0-9-]*$'
const NOT_FOUND = '{"error":{"code":"NOT_FOUND","message":"not found","retryable":false}}'

let app: FastifyInstance
let baseUrl: string
const clients: Client[] = []
let cookieA: string
let cookieB: string
let userB: string
let acctA: Client
let acctB: Client
let VA: string
let VA2: string
let VB: string

function field(body: unknown, key: string): string {
  if (body && typeof body === 'object' && key in body) {
    const value: unknown = Reflect.get(body, key)
    if (typeof value === 'string') return value
  }
  throw new Error(`response has no ${key}: ${JSON.stringify(body)}`)
}

async function post(cookie: string, url: string, body: Args): Promise<unknown> {
  const res = await app.inject({ method: 'POST', url, headers: { cookie }, body })
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`)
  return res.json()
}

async function mint(cookie: string, body: Args): Promise<Client> {
  const token = field(await post(cookie, '/api/mcp-connections', body), 'token')
  const client = new Client({ name: 'mcp-errors-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

async function ok(client: Client, name: string, args: Args): Promise<void> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`)
}

/** A failed call: its raw text and its parsed `error`, after checking the envelope's shape. */
async function failure(client: Client, name: string, args: Args): Promise<{ text: string; error: ErrorBody }> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  const text = content.map((c) => c.text ?? '').join('')
  expect(result.isError, `${name} ${JSON.stringify(args)} answered ${text.slice(0, 200)}`).toBe(true)
  expect(result.structuredContent, name).toBeUndefined()
  expect(content).toHaveLength(1)
  expect(text, `${name}: the text is the JSON envelope`).toMatch(/^\{"error":\{"code":"[A-Z_]+","message":/)
  const parsed = JSON.parse(text) as { error: ErrorBody }
  expect(Object.keys(parsed)).toEqual(['error'])
  const { error } = parsed
  expect(Object.keys(error).slice(0, 3)).toEqual(['code', 'message', 'retryable'])
  expect(typeof error.message).toBe('string')
  expect(typeof error.retryable).toBe('boolean')
  // `suggestions` is left out rather than empty.
  if (error.suggestions !== undefined) expect(error.suggestions.length).toBeGreaterThan(0)
  return { text, error }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const a = await createActiveUser()
  const b = await createActiveUser()
  userB = b.id
  cookieA = await loginCookie(app, a.email)
  cookieB = await loginCookie(app, b.email)
  VA = field(await post(cookieA, '/api/vaults', { name: 'errors-a' }), 'id')
  VA2 = field(await post(cookieA, '/api/vaults', { name: 'errors-a-shared' }), 'id')
  VB = field(await post(cookieB, '/api/vaults', { name: 'errors-b' }), 'id')
  acctA = await mint(cookieA, { name: 'errors-a', scope: 'account', access: 'admin' })
  acctB = await mint(cookieB, { name: 'errors-b', scope: 'account', access: 'admin' })
  await ok(acctA, 'create_note', { vaultId: VA, path: 'concepts/alpha-note', body: 'alpha' })
  await ok(acctA, 'create_note', { vaultId: VA, path: 'concepts/gamma-ray', body: 'gamma' })
  await ok(acctB, 'create_note', { vaultId: VB, path: 'concepts/bravo-note', body: 'bravo' })
  await ok(acctA, 'share_vault', { vaultId: VA2, granteeType: 'user', granteeId: userB, permission: 'edit' })
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('structured MCP errors (#439)', () => {
  it('a missing note is NOT_FOUND with the closest paths of the vault the caller reads', async () => {
    const typo = await failure(acctA, 'read_note', { vaultId: VA, path: 'concepts/alpha-nte' })
    expect(typo.error).toEqual({ code: 'NOT_FOUND', message: 'note not found', retryable: false, suggestions: ['concepts/alpha-note'] })
    // Same name in another folder.
    expect((await failure(acctA, 'read_note', { vaultId: VA, path: 'docs/alpha-note' })).error.suggestions).toEqual(['concepts/alpha-note'])
    // Nothing close: no `suggestions` key at all.
    expect((await failure(acctA, 'read_note', { vaultId: VA, path: 'zzz/nothing-like-it' })).text).toBe(
      '{"error":{"code":"NOT_FOUND","message":"note not found","retryable":false}}',
    )
    // Every note tool that names a path answers alike.
    for (const [tool, args] of [
      ['export_note', { vaultId: VA, path: 'concepts/alpha-nte' }],
      ['delete_note', { vaultId: VA, path: 'concepts/alpha-nte' }],
      ['note_history', { vaultId: VA, path: 'concepts/alpha-nte' }],
      ['rename_note', { vaultId: VA, from: 'concepts/alpha-nte', toName: 'renamed' }],
    ] as const) {
      expect((await failure(acctA, tool, args)).error, tool).toEqual(typo.error)
    }
  })

  it("another account's vault answers the exact bytes of a missing vault: no suggestions from outside the caller's reach", async () => {
    const theirs = await failure(acctB, 'read_note', { vaultId: VA, path: 'concepts/alpha-nte' })
    const missing = await failure(acctB, 'read_note', { vaultId: randomUUID(), path: 'concepts/alpha-nte' })
    expect(theirs.text).toBe(NOT_FOUND)
    expect(missing.text).toBe(NOT_FOUND)
    // In B's own vault, A's note is never suggested.
    expect((await failure(acctB, 'read_note', { vaultId: VB, path: 'concepts/alpha-nte' })).error).toEqual({
      code: 'NOT_FOUND',
      message: 'note not found',
      retryable: false,
    })
    expect((await failure(acctB, 'read_note', { vaultId: VB, path: 'concepts/bravo-nte' })).error.suggestions).toEqual(['concepts/bravo-note'])
  })

  it('argument validation (the SDK refusal) is INVALID_ARGUMENT with the field and suggestions', async () => {
    const unknown = await failure(acctA, 'create_note', { vaultId: VA, path: 'concepts/x', content: 'the body' })
    expect(unknown.error).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false, field: 'content', suggestions: ['body'] })
    expect(unknown.error.message).toMatch(/^Invalid arguments for tool create_note: unknown argument "content" \(did you mean "body"\?\)/)
    expect(unknown.text).not.toMatch(/MCP error|-32602/)

    // No close name: the tool's parameters.
    const far = await failure(acctA, 'read_note', { vaultId: VA, path: 'concepts/x', zzNotAParameter: 1 })
    expect(far.error).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'zzNotAParameter', suggestions: ['vaultId', 'path', 'targets', 'outline', 'if_rev', 'budget_tokens', 'cursor'] })

    const badUuid = await failure(acctA, 'read_note', { vaultId: 'not-a-uuid', path: 'concepts/x' })
    expect(badUuid.error).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'vaultId' })
    expect(badUuid.error.message).toContain('Invalid UUID')
    expect(badUuid.error.suggestions).toBeUndefined()

    // An enum lists its values.
    expect((await failure(acctA, 'graph', { vaultId: VA, aggregate: 'all' })).error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      field: 'aggregate',
      suggestions: ['community', 'none'],
    })

    // A nested object names the whole path.
    expect((await failure(acctA, 'edit_note', { vaultId: VA, path: 'concepts/alpha-note', ops: [{ op: 'append', txt: 'x' }] })).error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      field: 'ops.0.txt',
      suggestions: ['text'],
    })

    // A handler's own argument refusal has the same code.
    expect((await failure(acctA, 'graph', { vaultId: VA, depth: 2 })).error.code).toBe('INVALID_ARGUMENT')
    expect((await failure(acctA, 'read_note', { path: 'concepts/x' })).error).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'vaultId' })
  })

  it('an unknown tool is NOT_FOUND with the close names among the tools this connection lists', async () => {
    const { error } = await failure(acctA, 'read_notes', { vaultId: VA, path: 'concepts/alpha-note' })
    expect(error.code).toBe('NOT_FOUND')
    expect(error.suggestions).toContain('read_note')
  })

  it('note refusals: OKF_INVALID with the slug rule, a non-string type, ALREADY_EXISTS, TOO_LARGE', async () => {
    expect((await failure(acctA, 'create_note', { vaultId: VA, path: 'concepts/Bad_Name', body: 'x' })).error).toEqual({
      code: 'OKF_INVALID',
      message: 'invalid path segment: Bad_Name',
      retryable: false,
      rule: SLUG_RULE,
    })
    expect((await failure(acctA, 'create_note', { vaultId: VA, type: 'Concepts', name: 'ok', body: 'x' })).error).toMatchObject({
      code: 'OKF_INVALID',
      rule: SLUG_RULE,
    })
    // A type other than the folder is the note's own OKF type (#444); only a non-string one is refused.
    expect((await failure(acctA, 'create_note', { vaultId: VA, path: 'concepts/typed', frontmatter: { type: 7 }, body: 'x' })).error).toEqual({
      code: 'OKF_INVALID',
      message: 'frontmatter type must be a non-empty string',
      retryable: false,
    })
    expect((await failure(acctA, 'create_note', { vaultId: VA, path: 'concepts/alpha-note', body: 'again' })).error).toEqual({
      code: 'ALREADY_EXISTS',
      message: 'a note already exists at concepts/alpha-note',
      retryable: false,
    })
    const big = await failure(acctA, 'create_note', { vaultId: VA, path: 'concepts/too-big', body: 'x'.repeat(config.noteMaxBytes + 1) })
    expect(big.error).toMatchObject({ code: 'TOO_LARGE', retryable: false })
    expect(big.error.rule).toContain(String(config.noteMaxBytes))
  })

  it('permission, connection and cursor refusals have their codes', async () => {
    // B can edit VA2 but does not own it.
    expect((await failure(acctB, 'update_vault', { vaultId: VA2, name: 'mine now' })).error).toEqual({
      code: 'PERMISSION_REQUIRED',
      message: 'owner permission required',
      retryable: false,
    })
    const reader = await mint(cookieA, { name: 'errors-reader', scope: 'account', access: 'admin', profile: 'reader' })
    const profile = await failure(reader, 'create_note', { vaultId: VA, path: 'concepts/r', body: 'x' })
    expect(profile.error).toMatchObject({ code: 'TOOL_NOT_ALLOWED', retryable: false })
    expect(profile.error.message).toContain('needs the writer profile')
    const pinned = await mint(cookieA, { name: 'errors-pinned', scope: 'vault', vaultId: VA, access: 'write' })
    expect((await failure(pinned, 'read_note', { vaultId: VA2, path: 'concepts/alpha-note' })).error).toEqual({
      code: 'TOOL_NOT_ALLOWED',
      message: 'this connection is pinned to a different vault',
      retryable: false,
    })
    expect((await failure(acctA, 'browse_vault', { vaultId: VA, cursor: 'bogus' })).error).toMatchObject({ code: 'CURSOR_INVALID', retryable: false })
  })

  it('retryable: a busy answer says so, a refusal does not', async () => {
    const created = (await post(cookieA, '/api/repositories', { name: `errors-repo-${Date.now()}`, ingestionMethod: 'agent_push' })) as { id: string }
    expect((await failure(acctA, 'sync_repository', { repositoryId: created.id })).error).toEqual({
      code: 'CONFLICT',
      message: 'agent-push repositories are updated by agent, not by sync',
      retryable: false,
    })
    await db
      .update(repositories)
      .set({ ingestionMethod: 'git', gitUrl: 'https://example.com/o/r.git', syncStatus: 'syncing' })
      .where(eq(repositories.id, created.id))
    expect((await failure(acctA, 'sync_repository', { repositoryId: created.id })).error).toEqual({
      code: 'BUSY',
      message: 'a sync is already running',
      retryable: true,
    })
  })
  it("owner-only tools answer a missing id and another account's id with the same NOT_FOUND bytes; a visible one PERMISSION_REQUIRED (#439 review)", async () => {
    const repoB = (await post(cookieB, '/api/repositories', { name: `errors-repo-b-${Date.now()}`, ingestionMethod: 'agent_push' })) as { id: string }
    resetRateLimits()
    const teamB = JSON.parse(
      ((await acctB.callTool({ name: 'create_team', arguments: { name: `errors-team-b-${Date.now()}` } })).content as Array<{ text: string }>)[0]!.text,
    ) as { id: string }
    for (const [tool, key, theirs] of [
      ['delete_vault', 'vaultId', VB],
      ['list_vault_shares', 'vaultId', VB],
      ['delete_repository', 'repositoryId', repoB.id],
      ['delete_team', 'teamId', teamB.id],
    ] as const) {
      const foreign = await failure(acctA, tool, { [key]: theirs })
      const missing = await failure(acctA, tool, { [key]: randomUUID() })
      expect(foreign.text, `${tool} on B's id`).toBe(NOT_FOUND)
      expect(missing.text, `${tool} on a missing id`).toBe(NOT_FOUND)
    }
    // B is a member of A's team but not its owner: the team is visible, the action needs more.
    resetRateLimits()
    const teamA = JSON.parse(
      ((await acctA.callTool({ name: 'create_team', arguments: { name: `errors-team-a-${Date.now()}` } })).content as Array<{ text: string }>)[0]!.text,
    ) as { id: string }
    await ok(acctA, 'add_team_member', { teamId: teamA.id, userId: userB })
    expect((await failure(acctB, 'delete_team', { teamId: teamA.id })).error).toEqual({
      code: 'PERMISSION_REQUIRED',
      message: 'team owner required',
      retryable: false,
    })
  })

  it('a bad or missing union tag (an ops[] entry\'s op) suggests the tag values (#439 review)', async () => {
    const { error } = await failure(acctA, 'edit_note', { vaultId: VA, path: 'concepts/alpha-note', ops: [{ op: 'apend', text: 'x' }] })
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'ops.0.op' })
    expect(error.suggestions).toContain('append')
    expect(error.suggestions).toContain('replace_text')
  })

  it('a large subfolder does not crowd the siblings out of the suggestions (#439 review)', async () => {
    const vault = field(await post(cookieA, '/api/vaults', { name: 'errors-a-big' }), 'id')
    await ok(acctA, 'create_note', { vaultId: vault, path: 'concepts/alpha-note', body: 'alpha' })
    // 501 notes in concepts/aaa/, which sort before concepts/alpha-note.
    await db.insert(notes).values(
      Array.from({ length: 501 }, (_, i) => {
        const name = `aaa/n-${String(i).padStart(3, '0')}`
        return { vaultId: vault, type: 'concepts', name, path: `concepts/${name}`, frontmatter: { type: 'concepts' }, body: '' }
      }),
    )
    expect((await failure(acctA, 'read_note', { vaultId: vault, path: 'concepts/alpha-nte' })).error.suggestions).toEqual(['concepts/alpha-note'])
  })
})
