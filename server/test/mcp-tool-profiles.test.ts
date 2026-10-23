// Tool profiles (#428): a token's profile is the set of tools it lists and
// may call: `reader` (find, read, code questions), `writer` (reader plus note
// writes) or `admin` (every tool). It narrows what the allow-list, access
// level, scope and pin already allow and never widens them. Tokens minted
// before profiles existed, and API mints that name none, are `admin`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { listMcpTools } from '../src/mcp/server.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { db } from '../src/db/client.js'
import { mcpConnections } from '../src/db/schema.js'
import { generateToken, hashToken } from '../src/auth/tokens.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>

/** The reader profile over today's tools; `orient`, `grep`, `outline` and the code-question tools join as they land. */
const READER = [
  'browse_repository',
  'browse_vault',
  'find_graph_path',
  'find_symbols',
  'graph',
  'list_repositories',
  'list_vaults',
  'read_file',
  'read_note',
  'search',
]
/** What `writer` adds to `reader`. */
const WRITER_ADDS = ['append_note', 'create_note', 'edit_note']
const WRITER = [...READER, ...WRITER_ADDS].sort()

let app: FastifyInstance
let baseUrl: string
let ownerId: string
let ownerCookie: string
let vaultId: string
let repositoryId: string
let admin: Client
const clients: Client[] = []

/** A string field of a JSON response body. */
function field(body: unknown, key: string): string {
  if (body && typeof body === 'object' && key in body) {
    const value: unknown = Reflect.get(body, key)
    if (typeof value === 'string') return value
  }
  throw new Error(`response has no ${key}: ${JSON.stringify(body)}`)
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'tool-profiles-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

async function post(url: string, body: Args): Promise<unknown> {
  const res = await app.inject({ method: 'POST', url, headers: { cookie: ownerCookie }, body })
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`)
  return res.json()
}

/** Mints a token through the API and connects with it; also returns the connection as the API shows it. */
async function mint(body: Args): Promise<{ client: Client; connection: unknown }> {
  const connection = await post('/api/mcp-connections', body)
  return { client: await mcpClient(field(connection, 'token')), connection }
}

async function listed(client: Client): Promise<string[]> {
  resetRateLimits()
  return (await client.listTools()).tools.map((t) => t.name).sort()
}

async function listSize(client: Client): Promise<number> {
  resetRateLimits()
  return JSON.stringify({ tools: (await client.listTools()).tools }).length
}

async function call(client: Client, name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  const content: unknown[] = Array.isArray(result.content) ? result.content : []
  return { isError: result.isError === true, text: content.map((c) => field(c, 'text')).join('') }
}

async function refusal(client: Client, name: string, args: Args): Promise<string> {
  const { isError, text } = await call(client, name, args)
  expect(isError, `${name}: ${text}`).toBe(true)
  return text
}

const allTools = () =>
  listMcpTools()
    .map((t) => t.name)
    .sort()

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  ownerId = owner.id
  ownerCookie = await loginCookie(app, owner.email)
  vaultId = field(await post('/api/vaults', { name: 'tool-profiles' }), 'id')
  repositoryId = field(await post('/api/repositories', { name: 'tool-profiles-repo', ingestionMethod: 'agent_push' }), 'id')
  admin = (await mint({ name: 'profiles-admin', scope: 'account', access: 'admin', profile: 'admin' })).client
  const created = await call(admin, 'create_note', { vaultId, type: 'docs', name: 'kept', body: 'unchanged' })
  expect(created.isError, created.text).toBe(false)
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('tools/list per profile (#428)', () => {
  it('a reader account token lists exactly the reader tools', async () => {
    const { client, connection } = await mint({ name: 'profiles-reader', scope: 'account', access: 'admin', profile: 'reader' })
    expect(field(connection, 'profile')).toBe('reader')
    expect(await listed(client)).toEqual(READER)
  })

  it('a writer account token lists the reader tools and the note writes', async () => {
    const { client } = await mint({ name: 'profiles-writer', scope: 'account', access: 'admin', profile: 'writer' })
    expect(await listed(client)).toEqual(WRITER)
  })

  it('an admin account token lists every tool', async () => {
    expect(await listed(admin)).toEqual(allTools())
  })

  it('pinned reader tokens list the reader tools their scope reaches', async () => {
    const vault = await mint({ name: 'profiles-vault-reader', scope: 'vault', vaultId, profile: 'reader' })
    expect(await listed(vault.client)).toEqual(['browse_vault', 'find_graph_path', 'graph', 'read_note', 'search'])
    const repo = await mint({ name: 'profiles-repo-reader', scope: 'repository', repositoryId, profile: 'reader' })
    expect(await listed(repo.client)).toEqual(['browse_repository', 'find_graph_path', 'find_symbols', 'graph', 'read_file', 'search'])
  })

  it('reports the tools/list size of each profile (characters/4)', async () => {
    const sizes: Record<string, number> = {}
    for (const profile of ['reader', 'writer', 'admin']) {
      const { client } = await mint({ name: `profiles-size-${profile}`, scope: 'account', access: 'admin', profile })
      sizes[profile] = await listSize(client)
    }
    console.log(
      Object.entries(sizes)
        .map(([profile, chars]) => `tools/list ${profile} account token: ${chars} chars, ~${Math.round(chars / 4)} tokens`)
        .join('\n'),
    )
    expect(sizes.reader).toBeLessThan(sizes.writer!)
    expect(sizes.writer).toBeLessThan(sizes.admin!)
  })
})

describe('calls outside the profile are refused (#428)', () => {
  it('a reader token cannot write, and nothing is written', async () => {
    const { client } = await mint({ name: 'profiles-reader-call', scope: 'account', access: 'admin', profile: 'reader' })
    expect(await refusal(client, 'edit_note', { vaultId, path: 'docs/kept', body: 'changed' })).toMatch(
      /edit_note needs the writer profile; this connection has the reader profile/,
    )
    expect(await refusal(client, 'create_note', { vaultId, type: 'docs', name: 'refused', body: 'x' })).toMatch(
      /create_note needs the writer profile; this connection has the reader profile/,
    )
    const read = await call(client, 'read_note', { vaultId, path: 'docs/kept' })
    expect(read.isError, read.text).toBe(false)
    expect(read.text).toContain('unchanged')
    expect((await call(admin, 'read_note', { vaultId, path: 'docs/refused' })).text).toMatch(/note not found/)
  })

  it('a writer token cannot call admin-profile tools', async () => {
    const { client } = await mint({ name: 'profiles-writer-call', scope: 'account', access: 'admin', profile: 'writer' })
    expect(await refusal(client, 'delete_note', { vaultId, path: 'docs/kept' })).toMatch(
      /delete_note needs the admin profile; this connection has the writer profile/,
    )
    expect(await refusal(client, 'list_trash', { vaultId })).toMatch(/list_trash needs the admin profile/)
    expect((await call(admin, 'read_note', { vaultId, path: 'docs/kept' })).isError).toBe(false)
  })
})

describe('a profile never widens what a token may do (#428)', () => {
  it('a read-access writer token lists no write tool and is refused for want of access', async () => {
    const { client } = await mint({ name: 'profiles-read-writer', scope: 'account', access: 'read', profile: 'writer' })
    expect(await listed(client)).toEqual(READER)
    expect(await refusal(client, 'create_note', { vaultId, type: 'docs', name: 'nope', body: 'x' })).toMatch(
      /create_note needs the write capability; this connection has read access/,
    )
  })

  it('an allow-list and a profile intersect', async () => {
    const { client } = await mint({
      name: 'profiles-allow-list',
      scope: 'account',
      access: 'admin',
      profile: 'reader',
      allowedTools: ['search', 'read_note', 'create_note', 'list_trash'],
    })
    expect(await listed(client)).toEqual(['read_note', 'search'])
    expect(await refusal(client, 'create_note', { vaultId, type: 'docs', name: 'nope', body: 'x' })).toMatch(/create_note needs the writer profile/)
  })

  it('an admin-profile token keeps its access level', async () => {
    const { client } = await mint({ name: 'profiles-read-admin', scope: 'vault', vaultId, access: 'read', profile: 'admin' })
    const names = await listed(client)
    expect(names).toContain('note_history')
    expect(names).not.toContain('create_note')
    expect(names).not.toContain('share_vault')
  })

  it('refuses an unknown profile at mint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: ownerCookie },
      body: { name: 'profiles-bad', scope: 'account', profile: 'everything' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('existing tokens are unchanged (#428)', () => {
  it('a token stored without a profile, as before migration 0032, is admin and lists every tool', async () => {
    const token = generateToken()
    const [row] = await db
      .insert(mcpConnections)
      .values({ userId: ownerId, name: 'profiles-legacy', scope: 'account', access: 'admin', tokenHash: hashToken(token) })
      .returning()
    expect(row!.profile).toBe('admin')
    expect(await listed(await mcpClient(token))).toEqual(allTools())
  })

  it('an API mint without a profile is admin', async () => {
    const { client, connection } = await mint({ name: 'profiles-default', scope: 'account' })
    expect(field(connection, 'profile')).toBe('admin')
    expect(await listed(client)).toEqual(allTools())
    const res = await app.inject({ method: 'GET', url: '/api/mcp-connections', headers: { cookie: ownerCookie } })
    const rows = res.json<Array<{ name: string; profile: string }>>()
    expect(rows.find((r) => r.name === 'profiles-default')?.profile).toBe('admin')
  })
})
