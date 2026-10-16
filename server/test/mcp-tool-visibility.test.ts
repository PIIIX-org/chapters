// tools/list advertises only the tools a token can call (#641): its tool
// allow-list, its access level and its scope. A hidden tool stays callable,
// and the call answers with the refusal that says why.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { listMcpTools, type McpToolInfo } from '../src/mcp/server.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
type Access = McpToolInfo['capability']

let app: FastifyInstance
let baseUrl: string
let ownerCookie: string
let vaultId: string
let repositoryId: string
const clients: Client[] = []

const RANK: Record<Access, number> = { read: 0, write: 1, admin: 2 }
// The tool scopes each connection scope reaches; mcp-scope.test.ts proves the others are refused.
const REACH: Record<'account' | 'vault' | 'repository', Array<McpToolInfo['scope']>> = {
  account: ['account', 'vault', 'vault-or-account', 'repository', 'repository-or-account', 'vault-or-repo'],
  vault: ['vault', 'vault-or-account', 'vault-or-repo'],
  repository: ['repository', 'repository-or-account', 'vault-or-repo'],
}

/** A string field of a JSON response body. */
function field(body: unknown, key: string): string {
  if (body && typeof body === 'object' && key in body) {
    const value: unknown = Reflect.get(body, key)
    if (typeof value === 'string') return value
  }
  throw new Error(`response has no ${key}: ${JSON.stringify(body)}`)
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'tool-visibility-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

async function post(url: string, body: Args): Promise<unknown> {
  const res = await app.inject({ method: 'POST', url, headers: { cookie: ownerCookie }, body })
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`)
  return res.json()
}

async function mint(body: Args): Promise<Client> {
  return mcpClient(field(await post('/api/mcp-connections', body), 'token'))
}

async function listed(client: Client): Promise<string[]> {
  resetRateLimits()
  return (await client.listTools()).tools.map((t) => t.name).sort()
}

async function refusal(client: Client, name: string, args: Args): Promise<string> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, name).toBe(true)
  const content: unknown[] = Array.isArray(result.content) ? result.content : []
  return content.map((c) => field(c, 'text')).join('')
}

/** The tools a token with these capabilities can call, from the registrations themselves. */
function callable(scope: keyof typeof REACH, access: Access): string[] {
  return listMcpTools()
    .filter((t) => REACH[scope].includes(t.scope) && RANK[t.capability] <= RANK[access])
    .map((t) => t.name)
    .sort()
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  vaultId = field(await post('/api/vaults', { name: 'tool-visibility' }), 'id')
  repositoryId = field(await post('/api/repositories', { name: 'tool-visibility-repo', ingestionMethod: 'agent_push' }), 'id')
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('tools/list shows only the tools a token can call (#641)', () => {
  it('an admin account token lists every tool', async () => {
    const all = listMcpTools()
      .map((t) => t.name)
      .sort()
    expect(await listed(await mint({ name: 'vis-account-admin', scope: 'account', access: 'admin' }))).toEqual(all)
  })

  it('a read-only account token lists only read tools', async () => {
    const names = await listed(await mint({ name: 'vis-account-read', scope: 'account', access: 'read' }))
    expect(names).toEqual(callable('account', 'read'))
    expect(names).toContain('list_vaults')
    expect(names).not.toContain('create_note')
  })

  it('a vault-pinned token lists no account-only, repository or admin tools', async () => {
    const names = await listed(await mint({ name: 'vis-vault-write', scope: 'vault', vaultId }))
    expect(names).toEqual(callable('vault', 'write'))
    expect(names).toEqual(expect.arrayContaining(['read_note', 'create_note', 'search', 'save_graph_perspective']))
    for (const hidden of ['list_vaults', 'share_vault', 'delete_vault', 'browse_repository', 'find_symbols']) {
      expect(names).not.toContain(hidden)
    }
  })

  it('a repository-pinned token lists no vault or account-only tools', async () => {
    const names = await listed(await mint({ name: 'vis-repo-read', scope: 'repository', repositoryId, access: 'read' }))
    expect(names).toEqual(callable('repository', 'read'))
    expect(names).toEqual(expect.arrayContaining(['browse_repository', 'read_file', 'find_symbols', 'search']))
    for (const hidden of ['read_note', 'list_graph_perspectives', 'list_repositories', 'sync_repository']) {
      expect(names).not.toContain(hidden)
    }
  })

  it('an allow-listed token lists only the allowed tools its access and scope permit, and gets no prompts', async () => {
    const limited = await mint({
      name: 'vis-allow-list',
      scope: 'vault',
      vaultId,
      access: 'read',
      // create_note needs write and list_vaults an account token: neither is listed.
      allowedTools: ['read_note', 'search', 'create_note', 'list_vaults'],
    })
    expect(await listed(limited)).toEqual(['read_note', 'search'])
    expect(limited.getServerCapabilities()?.prompts).toBeUndefined()

    const unlimited = await mint({ name: 'vis-no-allow-list', scope: 'vault', vaultId, access: 'read' })
    expect(unlimited.getServerCapabilities()?.prompts).toBeDefined()
    resetRateLimits()
    expect((await unlimited.listPrompts()).prompts.length).toBeGreaterThan(0)
  })

  it('calling a hidden tool still answers with the refusal that says why', async () => {
    const limited = await mint({ name: 'vis-refusal-limited', scope: 'vault', vaultId, access: 'read', allowedTools: ['read_note'] })
    expect(await refusal(limited, 'search', { query: 'x' })).toMatch(/search is not in this connection's tool allow-list/)

    const reader = await mint({ name: 'vis-refusal-reader', scope: 'vault', vaultId, access: 'read' })
    expect(await refusal(reader, 'create_note', { type: 'docs', name: 'nope', body: 'x' })).toMatch(
      /create_note needs the write capability; this connection has read access/,
    )
    expect(await refusal(reader, 'list_vaults', {})).toMatch(/list_vaults requires an account-scoped connection/)
  })
})
