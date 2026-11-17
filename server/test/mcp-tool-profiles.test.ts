// Tool profiles (#428): a token's profile is the set of tools it lists and
// may call: `reader` (find, read, code questions), `writer` (reader plus note
// writes) or `admin` (every tool). It narrows what the allow-list, access
// level, scope and pin already allow and never widens them. Tokens minted
// before profiles existed, and API mints that name none, are `admin`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { buildApp } from '../src/app.js'
import { listMcpTools } from '../src/mcp/server.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { TOOL_DISCOVERY_CAPABILITY, TOOL_DISCOVERY_HEADER } from '../src/mcp/tool-discovery.js'
import { db } from '../src/db/client.js'
import { mcpConnections } from '../src/db/schema.js'
import { generateToken, hashToken } from '../src/auth/tokens.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>

/** The reader profile over today's tools; `grep`, `outline` and the code-question tools join as they land. */
const READER = [
  'browse_repository',
  'browse_vault',
  'find_graph_path',
  'find_symbols',
  'graph',
  'grep',
  'list_repositories',
  'list_vaults',
  'orient',
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
const DiscoveryResult = z.object({ tools: z.array(ToolSchema), total: z.number() })
const HistoryResult = z.object({ revisions: z.array(z.object({ id: z.string() })) })
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

async function mcpClient(token: string, discovery = false, discoveryHeader = discovery): Promise<Client> {
  const client = new Client(
    { name: 'tool-profiles-test', version: '0.0.0' },
    discovery ? { capabilities: { experimental: { [TOOL_DISCOVERY_CAPABILITY]: { version: 1 } } } } : {},
  )
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}`, ...(discoveryHeader ? { [TOOL_DISCOVERY_HEADER]: '1' } : {}) } },
      }),
    )
  } catch (error) {
    await client.close()
    throw error
  }
  clients.push(client)
  return client
}

async function post(url: string, body: Args): Promise<unknown> {
  const res = await app.inject({ method: 'POST', url, headers: { cookie: ownerCookie }, body })
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`)
  return res.json()
}

/** Mints a token through the API and connects with it; also returns the connection as the API shows it. */
async function mint(body: Args, discovery = false): Promise<{ client: Client; connection: unknown }> {
  const connection = await post('/api/mcp-connections', body)
  return { client: await mcpClient(field(connection, 'token'), discovery), connection }
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
    expect(await listed(vault.client)).toEqual(['browse_vault', 'find_graph_path', 'graph', 'grep', 'orient', 'read_note', 'search'])
    const repo = await mint({ name: 'profiles-repo-reader', scope: 'repository', repositoryId, profile: 'reader' })
    expect(await listed(repo.client)).toEqual(['browse_repository', 'find_graph_path', 'find_symbols', 'graph', 'grep', 'orient', 'read_file', 'search'])
  })

  it('a reader token lists no prompts; writer and admin tokens keep them (owner decision on #930)', async () => {
    const reader = await mint({ name: 'profiles-prompts-reader', scope: 'account', profile: 'reader' })
    expect(reader.client.getServerCapabilities()?.prompts).toBeUndefined()
    for (const profile of ['writer', 'admin']) {
      const { client } = await mint({ name: `profiles-prompts-${profile}`, scope: 'account', profile })
      expect(client.getServerCapabilities()?.prompts, profile).toBeDefined()
      resetRateLimits()
      expect((await client.listPrompts()).prompts.length, profile).toBeGreaterThan(0)
    }
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

describe('opt-in long-tail discovery over stateless HTTP (#431)', () => {
  it('keeps default and capability-only clients unchanged while isolating a header-negotiated client on the SAME token', async () => {
    const connection = await post('/api/mcp-connections', { name: 'discovery-shared-token', scope: 'account', access: 'admin', profile: 'admin' })
    const token = field(connection, 'token')
    const legacy = await mcpClient(token)
    const discovered = await mcpClient(token, true)
    const capabilityOnly = await mcpClient(token, true, false)
    for (let i = 0; i < 2; i++) {
      expect(await listed(legacy)).toEqual(allTools())
      expect(await listed(discovered)).toEqual([...WRITER, 'tool_search'].sort())
      expect(await listed(capabilityOnly)).toEqual(allTools())
    }
    expect(discovered.getServerCapabilities()?.experimental?.[TOOL_DISCOVERY_CAPABILITY]).toEqual({ version: 1 })
    expect(legacy.getServerCapabilities()?.experimental?.[TOOL_DISCOVERY_CAPABILITY]).toBeUndefined()
    expect(discovered.getServerVersion()?.version).not.toBe(legacy.getServerVersion()?.version)
    console.log(`discovery tools/list ${await listSize(discovered)} chars; legacy ${await listSize(legacy)} chars; instructions ${(discovered.getInstructions() ?? '').length} chars`)
  })

  it('loads REAL descriptors and calls original tools through the SAME strict SDK registry, without a call meta-tool', async () => {
    const { client } = await mint({ name: 'discovery-sdk-consumer', scope: 'account', access: 'admin', profile: 'admin' }, true)
    expect(await listed(client)).not.toContain('note_history')
    const find = async (query: string) => {
      const result = await call(client, 'tool_search', { query, limit: 1 })
      expect(result.isError, result.text).toBe(false)
      const descriptor = DiscoveryResult.parse(JSON.parse(result.text)).tools[0]!
      expect(descriptor.name).toBe(query)
      return descriptor
    }
    const historyTool = await find('note_history')
    const args = { vaultId, path: 'docs/kept' }
    expect(new AjvJsonSchemaValidator().getValidator(historyTool.inputSchema)(args).valid).toBe(true)
    expect(await refusal(client, historyTool.name, { ...args, undeclared: 1 })).toMatch(/INVALID_ARGUMENT/)
    const history = await call(client, historyTool.name, args)
    expect(history.isError, history.text).toBe(false)
    const revisionId = HistoryResult.parse(JSON.parse(history.text)).revisions[0]!.id
    const revisionTool = await find('get_revision')
    const revision = await call(client, revisionTool.name, { vaultId, revisionId })
    expect(revision.isError, revision.text).toBe(false)
    expect(JSON.parse(revision.text)).toMatchObject({ id: revisionId, body: 'unchanged' })
    expect(await refusal(client, 'tool_search', { query: 'note_history', execute: {} })).toMatch(/INVALID_ARGUMENT/)
  })

  it('leaves reader/writer and the explicit nine-tool study allow-list unchanged', async () => {
    for (const [profile, names] of [['reader', READER], ['writer', WRITER]] as const) {
      const { client } = await mint({ name: `discovery-ignored-${profile}`, scope: 'account', access: 'admin', profile }, true)
      expect(await listed(client)).toEqual(names)
      expect(await refusal(client, 'tool_search', { query: 'note_history' })).toMatch(/NOT_FOUND/)
    }
    const allowedTools = ['search', 'find_symbols', 'read_file', 'browse_repository', 'repository_status', 'graph', 'find_graph_path', 'grep', 'orient']
    const { client } = await mint({ name: 'discovery-study-allowlist', scope: 'account', access: 'admin', profile: 'admin', allowedTools }, true)
    expect(await listed(client)).toEqual([...allowedTools].sort())
    expect(await refusal(client, 'note_history', { vaultId, path: 'docs/kept' })).toMatch(/TOOL_NOT_ALLOWED/)
    expect(await refusal(client, 'tool_search', { query: 'note_history' })).toMatch(/NOT_FOUND/)
  })

  it('scopes pinned discovery to live permissions, without leaking repository or edit-only schemas', async () => {
    const member = await createActiveUser()
    const cookie = await loginCookie(app, member.email)
    const share = { vaultId, granteeType: 'user', granteeId: member.id }
    expect((await call(admin, 'share_vault', { ...share, permission: 'read' })).isError).toBe(false)
    const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'discovery-pinned-member', scope: 'vault', vaultId, access: 'read', profile: 'admin' } })
    expect(minted.statusCode).toBe(200)
    const client = await mcpClient(field(minted.json(), 'token'), true)
    const hidden = await call(client, 'tool_search', { query: 'note_history' })
    expect(JSON.parse(hidden.text)).toMatchObject({ tools: [], total: 0 })
    const repository = await call(client, 'tool_search', { query: 'repository_status' })
    expect(JSON.parse(repository.text)).toMatchObject({ tools: [], total: 0 })
    expect((await call(admin, 'share_vault', { ...share, permission: 'edit' })).isError).toBe(false)
    const visible = await call(client, 'tool_search', { query: 'note_history' })
    expect(DiscoveryResult.parse(JSON.parse(visible.text)).tools.map((tool) => tool.name)).toContain('note_history')
    expect((await call(client, 'note_history', { path: 'docs/kept' })).isError).toBe(false)
    const denied = await call(client, 'note_history', { vaultId: crypto.randomUUID(), path: 'docs/kept' })
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/TOOL_NOT_ALLOWED/)
  })

  it('requires versioned per-request header AND initialization capability, with no persistent negotiation state', async () => {
    const connection = await post('/api/mcp-connections', { name: 'discovery-bad-handshake', scope: 'account', access: 'admin', profile: 'admin' })
    const token = field(connection, 'token')
    await expect(mcpClient(token, false, true)).rejects.toThrow(/requires initialize capability/)
    const bad = await app.inject({
      method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}`, [TOOL_DISCOVERY_HEADER]: '2' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toMatchObject({ error: { code: -32602 } })
    // A subsequent ordinary request on that token still lists the full catalog.
    expect(await listed(await mcpClient(token))).toEqual(allTools())
  })
})
