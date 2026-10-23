// #443: a NUL byte (U+0000) in a string argument reached Postgres, which
// refuses it in `text` (SQLSTATE 22021), and drizzle's DrizzleQueryError
// (`Failed query: <sql> params: <every parameter>`) became the reply: the
// SQL statement and the whole note body went back to the caller. Now a NUL
// in any string (or object key) of a tool call or a REST request is refused
// up front as an invalid argument naming the field, and a query that still
// fails answers a fixed message; the driver error goes to the server log only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { sql } from '../src/db/client.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>

/** Text a reply must never carry: SQL, and the body that was sent. */
const SECRET = 'nul-secret-body-443'
const FORCED = 'force-db-error-443'

let app: FastifyInstance
let cookie: string
let agent: Client
let vaultId: string
let repositoryId: string

/** No SQL and no sent body in `text`. */
function expectClean(text: string): void {
  const lower = text.toLowerCase()
  expect(lower).not.toContain('insert into')
  expect(lower).not.toContain('select')
  expect(lower).not.toContain('update ')
  expect(lower).not.toContain('failed query')
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain(FORCED)
}

async function call(name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

/** The MCP refusal of a NUL in `field`. */
const nulEnvelope = (field: string, message = `${field}: NUL bytes (U+0000) are not allowed`) =>
  JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message, retryable: false, field } })

async function expectNulRefused(name: string, args: Args, field: string, message?: string): Promise<void> {
  const r = await call(name, args)
  expectClean(r.text)
  expect(r.isError, r.text.slice(0, 300)).toBe(true)
  expect(r.text).toBe(nulEnvelope(field, message))
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const user = await createActiveUser()
  cookie = await loginCookie(app, user.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'nul-bytes' } })).json<{ id: string }>().id
  repositoryId = (
    await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'nul-bytes-repo', ingestionMethod: 'agent_push' } })
  ).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'nul-bytes', scope: 'account', access: 'admin' } })
  agent = new Client({ name: 'nul-bytes-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  const created = await call('create_note', { vaultId, path: 'concepts/clean', body: 'clean' })
  expect(created.isError, created.text).toBe(false)
  // A real query failure past every argument check: Postgres raises on a note row whose body holds the marker.
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION test_443_force_error() RETURNS trigger AS $$
    BEGIN
      IF NEW.body LIKE '%${FORCED}%' THEN RAISE EXCEPTION 'forced failure for #443'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`)
  await sql.unsafe('DROP TRIGGER IF EXISTS test_443_force_error ON notes')
  await sql.unsafe('CREATE TRIGGER test_443_force_error BEFORE INSERT OR UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION test_443_force_error()')
})

afterAll(async () => {
  await sql.unsafe('DROP TRIGGER IF EXISTS test_443_force_error ON notes')
  await sql.unsafe('DROP FUNCTION IF EXISTS test_443_force_error()')
  await agent?.close()
  await app?.close()
})

describe('MCP: a NUL byte in a string argument is INVALID_ARGUMENT naming the field (#443)', () => {
  it('create_note with a NUL in the body', async () => {
    await expectNulRefused('create_note', { vaultId, path: 'concepts/nul-body', body: `before ${SECRET}\u0000after` }, 'body')
  })

  it('edit_note with a NUL in the body', async () => {
    await expectNulRefused('edit_note', { vaultId, path: 'concepts/clean', body: `${SECRET}\u0000` }, 'body')
  })

  it('a frontmatter value and a frontmatter key', async () => {
    await expectNulRefused('create_note', { vaultId, path: 'concepts/nul-fm', frontmatter: { title: `${SECRET}\u0000` }, body: 'x' }, 'frontmatter.title')
    await expectNulRefused(
      'edit_note',
      { vaultId, path: 'concepts/clean', frontmatter: { [`k\u0000${SECRET}`]: 'v' } },
      'frontmatter',
      'frontmatter: NUL bytes (U+0000) are not allowed (in a key)',
    )
  })

  it('an edit op text and a list entry', async () => {
    await expectNulRefused('edit_note', { vaultId, path: 'concepts/clean', ops: [{ op: 'append', text: `${SECRET}\u0000` }] }, 'ops.0.text')
    await expectNulRefused('edit_note', { vaultId, path: 'concepts/clean', removeKeys: ['a', `${SECRET}\u0000`] }, 'removeKeys.1')
  })

  it('a NUL path to browse_repository and read_file', async () => {
    await expectNulRefused('browse_repository', { repositoryId, path: `src/${SECRET}\u0000` }, 'path')
    await expectNulRefused('read_file', { repositoryId, path: `src/${SECRET}\u0000.ts` }, 'path')
  })

  it('a prompt argument (prompts/get) is InvalidParams naming the field', async () => {
    resetRateLimits()
    await expect(
      agent.getPrompt({ name: 'active_project_companion', arguments: { projectName: `${SECRET}\u0000`, taskDescription: 't' } }),
    ).rejects.toThrow('MCP error -32602: arguments.projectName: NUL bytes (U+0000) are not allowed')
  })

  it('tab, LF, CR and other control characters stay legal', async () => {
    const r = await call('create_note', { vaultId, path: 'concepts/controls', body: 'a\tb\nc\r\nd \u001b[0m \u0007 e' })
    expect(r.isError, r.text).toBe(false)
  })
})

describe('REST: a NUL byte in the body, a path parameter or the query string is a 400 naming the field (#443)', () => {
  async function expectRestRefused(res: { statusCode: number; body: string }, field: string): Promise<void> {
    expectClean(res.body)
    expect(res.statusCode, res.body.slice(0, 300)).toBe(400)
    const message = `${field}: NUL bytes (U+0000) are not allowed`
    expect(JSON.parse(res.body)).toEqual({ statusCode: 400, error: message, message, code: 'INVALID_ARGUMENT', field })
  }

  it('note create with a NUL in the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'concepts', name: 'rest-nul', body: `${SECRET}\u0000` },
    })
    await expectRestRefused(res, 'body')
  })

  it('note update with a NUL in the body and in a frontmatter value', async () => {
    const url = `/api/vaults/${vaultId}/notes/concepts/clean`
    await expectRestRefused(await app.inject({ method: 'PUT', url, headers: { cookie }, body: { body: `${SECRET}\u0000` } }), 'body')
    await expectRestRefused(await app.inject({ method: 'PUT', url, headers: { cookie }, body: { frontmatter: { title: `\u0000${SECRET}` } } }), 'frontmatter.title')
  })

  it('a NUL in a path parameter and in the query string', async () => {
    await expectRestRefused(await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/notes/concepts/a%00b`, headers: { cookie } }), 'params.*')
    await expectRestRefused(await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/search?q=a%00b`, headers: { cookie } }), 'query.q')
  })
})

describe('a query that fails in Postgres answers a fixed message, never its SQL or parameters (#443)', () => {
  it('MCP: INTERNAL "a database query failed" with the SQLSTATE', async () => {
    const r = await call('create_note', { vaultId, path: 'concepts/forced', body: `${FORCED} ${SECRET}` })
    expectClean(r.text)
    expect(r.isError).toBe(true)
    expect(r.text).toBe(JSON.stringify({ error: { code: 'INTERNAL', message: 'a database query failed (P0001)', retryable: false } }))
  })

  it('REST: 500 "a database query failed"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'concepts', name: 'forced-rest', body: `${FORCED} ${SECRET}` },
    })
    expectClean(res.body)
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ statusCode: 500, error: 'a database query failed', message: 'a database query failed' })
  })
})
