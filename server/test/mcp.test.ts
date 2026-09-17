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

  it('exposes expanded system tools and forbids mcp connection creation', async () => {
    const client = await mcpClient(accountToken)
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)

    // Vault tools
    expect(names).toContain('create_vault')
    expect(names).toContain('update_vault')
    expect(names).toContain('delete_vault')
    expect(names).toContain('restore_vault')
    expect(names).toContain('purge_vault')
    expect(names).toContain('list_vault_shares')
    expect(names).toContain('share_vault')
    expect(names).toContain('revoke_vault_share')

    // Note tools
    expect(names).toContain('rename_note')
    expect(names).toContain('list_trash')
    expect(names).toContain('restore_note')
    expect(names).toContain('purge_note')
    expect(names).toContain('purge_revision')
    expect(names).toContain('export_note')

    // Repository tools
    expect(names).toContain('connect_repository')
    expect(names).toContain('update_repository')
    expect(names).toContain('delete_repository')
    expect(names).toContain('sync_repository')
    expect(names).toContain('list_repository_shares')
    expect(names).toContain('share_repository')
    expect(names).toContain('revoke_repository_share')

    // Team & user tools
    expect(names).toContain('list_teams')
    expect(names).toContain('create_team')
    expect(names).toContain('list_team_members')
    expect(names).toContain('add_team_member')
    expect(names).toContain('remove_team_member')
    expect(names).toContain('delete_team')
    expect(names).toContain('lookup_user')

    // Export & Notification tools
    expect(names).toContain('export_vault')
    expect(names).toContain('list_notifications')
    expect(names).toContain('mark_notification_read')

    // Security invariant: MCP cannot create new MCP connections
    expect(names).not.toContain('create_mcp_connection')
  })

  it('creates, updates, soft-deletes, and restores vaults via MCP', async () => {
    const client = await mcpClient(accountToken)
    const createdRes = await client.callTool({
      name: 'create_vault',
      arguments: { name: 'AI Generated Vault' },
    })
    expect(createdRes.isError).toBeFalsy()
    const created = JSON.parse(textOf(createdRes)) as { id: string; name: string }
    expect(created.name).toBe('AI Generated Vault')

    const updatedRes = await client.callTool({
      name: 'update_vault',
      arguments: { vaultId: created.id, name: 'Renamed AI Vault' },
    })
    expect(updatedRes.isError).toBeFalsy()
    const updated = JSON.parse(textOf(updatedRes)) as { id: string; name: string }
    expect(updated.name).toBe('Renamed AI Vault')

    const deleteRes = await client.callTool({
      name: 'delete_vault',
      arguments: { vaultId: created.id },
    })
    expect(deleteRes.isError).toBeFalsy()

    const restoreRes = await client.callTool({
      name: 'restore_vault',
      arguments: { vaultId: created.id },
    })
    expect(restoreRes.isError).toBeFalsy()
    const restored = JSON.parse(textOf(restoreRes)) as { id: string; name: string }
    expect(restored.name).toBe('Renamed AI Vault')
  })

  it('manages note lifecycles (rename, export, trash, restore) via MCP', async () => {
    const client = await mcpClient(accountToken)

    const createdRes = await client.callTool({
      name: 'create_note',
      arguments: { vaultId, type: 'ideas', name: 'quantum-ai', body: 'AI generated content.' },
    })
    expect(createdRes.isError).toBeFalsy()

    const renamedRes = await client.callTool({
      name: 'rename_note',
      arguments: { vaultId, from: 'ideas/quantum-ai', toName: 'quantum-hyperdrive' },
    })
    expect(renamedRes.isError).toBeFalsy()

    const exportRes = await client.callTool({
      name: 'export_note',
      arguments: { vaultId, path: 'ideas/quantum-hyperdrive' },
    })
    expect(exportRes.isError).toBeFalsy()
    expect(textOf(exportRes)).toContain('AI generated content.')

    const deleteRes = await client.callTool({
      name: 'delete_note',
      arguments: { vaultId, path: 'ideas/quantum-hyperdrive' },
    })
    expect(deleteRes.isError).toBeFalsy()

    const trashRes = await client.callTool({
      name: 'list_trash',
      arguments: { vaultId },
    })
    expect(trashRes.isError).toBeFalsy()
    const trash = JSON.parse(textOf(trashRes)) as Array<{ id: string; path: string }>
    const trashedNote = trash.find((n) => n.path === 'ideas/quantum-hyperdrive')
    expect(trashedNote).toBeDefined()

    const restoreRes = await client.callTool({
      name: 'restore_note',
      arguments: { vaultId, noteId: trashedNote!.id },
    })
    expect(restoreRes.isError).toBeFalsy()
  })

  it('manages teams and user lookups via MCP', async () => {
    const client = await mcpClient(accountToken)

    const teamRes = await client.callTool({
      name: 'create_team',
      arguments: { name: 'AI Core Team' },
    })
    expect(teamRes.isError).toBeFalsy()
    const team = JSON.parse(textOf(teamRes)) as { id: string; name: string }

    const listTeamsRes = await client.callTool({
      name: 'list_teams',
      arguments: {},
    })
    expect(listTeamsRes.isError).toBeFalsy()
    const teamsList = JSON.parse(textOf(listTeamsRes)) as Array<{ id: string; name: string }>
    expect(teamsList.some((t) => t.id === team.id)).toBe(true)

    const membersRes = await client.callTool({
      name: 'list_team_members',
      arguments: { teamId: team.id },
    })
    expect(membersRes.isError).toBeFalsy()

    const deleteTeamRes = await client.callTool({
      name: 'delete_team',
      arguments: { teamId: team.id },
    })
    expect(deleteTeamRes.isError).toBeFalsy()
  })
})
