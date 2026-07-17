import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let baseUrl: string
let ownerCookie: string
let vaultId: string
let accountToken: string
let vaultToken: string
let accountConnectionId: string

const clients: Client[] = []

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content[0]?.text ?? ''
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  const owner = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'MCP vault' },
    })).json() as { id: string }
  ).id
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: ownerCookie },
    body: { type: 'docs', name: 'readme', body: 'The quantum flux capacitor manual.' },
  })

  const account = (
    await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: ownerCookie },
      body: { name: 'account-agent', scope: 'account' },
    })
  ).json() as { id: string; token: string }
  accountToken = account.token
  accountConnectionId = account.id
  vaultToken = (
    (await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: ownerCookie },
      body: { name: 'vault-agent', scope: 'vault', vaultId },
    })).json() as { token: string }
  ).token
})

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('MCP integration', () => {
  it('rejects missing/revoked tokens', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  it('lists tools and reads a note', async () => {
    const client = await mcpClient(accountToken)
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('read_note')
    expect(names).toContain('search')

    const result = await client.callTool({
      name: 'read_note',
      arguments: { vaultId, path: 'docs/readme' },
    })
    expect(textOf(result)).toContain('quantum flux capacitor')
  })

  it('hard-rejects account surfaces for vault-scoped tokens', async () => {
    const client = await mcpClient(vaultToken)

    // vault-scoped token can read within its pinned vault without vaultId
    const read = await client.callTool({
      name: 'read_note',
      arguments: { path: 'docs/readme' },
    })
    expect(textOf(read)).toContain('quantum')

    const listVaults = await client.callTool({ name: 'list_vaults', arguments: {} })
    expect(listVaults.isError).toBe(true)
    expect(textOf(listVaults)).toContain('account-scoped')

    const everywhere = await client.callTool({
      name: 'search',
      arguments: { query: 'quantum', everywhere: true },
    })
    expect(everywhere.isError).toBe(true)
  })

  it('writes with attribution, keeps history, reverts', async () => {
    const client = await mcpClient(accountToken)
    const edit = await client.callTool({
      name: 'edit_note',
      arguments: { vaultId, path: 'docs/readme', body: 'Rewritten by the agent.' },
    })
    expect(edit.isError).toBeFalsy()

    const history = await client.callTool({
      name: 'note_history',
      arguments: { vaultId, path: 'docs/readme' },
    })
    const revisions = JSON.parse(textOf(history)) as Array<{
      id: string
      actorType: string
      actorId: string | null
      body: string
    }>
    expect(revisions.length).toBeGreaterThanOrEqual(2)
    expect(revisions[0]!.actorType).toBe('mcp')
    expect(revisions[0]!.actorId).toBe(accountConnectionId)

    const original = revisions.find((r) => r.body.includes('quantum'))!
    const revert = await client.callTool({
      name: 'revert_note',
      arguments: { vaultId, path: 'docs/readme', revisionId: original.id },
    })
    expect(revert.isError).toBeFalsy()

    const read = await client.callTool({
      name: 'read_note',
      arguments: { vaultId, path: 'docs/readme' },
    })
    expect(textOf(read)).toContain('quantum flux capacitor')
  })

  it('search and graph work through MCP (same functions as the UI)', async () => {
    const client = await mcpClient(accountToken)
    const search = await client.callTool({
      name: 'search',
      arguments: { query: 'flux capacitor', vaultId },
    })
    expect(textOf(search)).toContain('docs/readme')

    const graph = await client.callTool({ name: 'graph', arguments: { vaultId } })
    const parsed = JSON.parse(textOf(graph)) as { nodes: unknown[] }
    expect(parsed.nodes.length).toBeGreaterThan(0)
  })

  it('revoking the connection cuts access immediately', async () => {
    const conn = (
      await app.inject({
        method: 'POST',
        url: '/api/mcp-connections',
        headers: { cookie: ownerCookie },
        body: { name: 'short-lived', scope: 'account' },
      })
    ).json() as { id: string; token: string }
    const client = await mcpClient(conn.token)
    const ok = await client.callTool({
      name: 'read_note',
      arguments: { vaultId, path: 'docs/readme' },
    })
    expect(ok.isError).toBeFalsy()

    await app.inject({
      method: 'POST',
      url: `/api/mcp-connections/${conn.id}/revoke`,
      headers: { cookie: ownerCookie },
    })
    await expect(
      client.callTool({ name: 'read_note', arguments: { vaultId, path: 'docs/readme' } }),
    ).rejects.toThrow()
  })
})
