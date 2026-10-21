// Every MCP tool declares the access level it needs (#548, #549), and the
// Settings UI reads the same list to build a tool allow-list.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { listMcpTools } from '../src/mcp/server.js'
import { createActiveUser, loginCookie } from './helpers.js'

// The tools that widen access to, change the settings of, or destroy a vault,
// repository or team, or erase history. A pinned token reaches them only with
// `admin`, which the owner grants at mint time.
const ADMIN_TOOLS = [
  'add_team_member',
  'connect_repository',
  'delete_repository',
  'delete_team',
  'delete_vault',
  'purge_note',
  'purge_revision',
  'purge_vault',
  'remove_team_member',
  'revoke_repository_share',
  'revoke_vault_share',
  'share_repository',
  'share_vault',
  'update_repository',
  'update_vault',
]

// Tools whose handler requires owner permission on the vault or repository
// (requireVaultOwner / requireRepositoryOwner), and tools whose handler
// requires edit permission on the vault (requireAccess 'edit'). tools/list
// leaves them out for a pinned token whose user lacks that permission (#649).
const OWNER_TOOLS = [
  'delete_repository',
  'delete_vault',
  'list_repository_shares',
  'list_vault_shares',
  'purge_note',
  'purge_revision',
  'revoke_repository_share',
  'revoke_vault_share',
  'share_repository',
  'share_vault',
  'update_repository',
  'update_vault',
]
const EDIT_TOOLS = [
  'append_note',
  'create_note',
  'delete_graph_perspective',
  'delete_note',
  'edit_note',
  'export_vault',
  'get_revision',
  'list_trash',
  'note_history',
  'rename_note',
  'restore_note',
  'revert_note',
  'save_graph_perspective',
  'upsert_note',
]

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

describe('MCP tool capabilities', () => {
  it('every tool declares read, write or admin, and the admin set is exactly the destructive/admin tools', () => {
    const tools = listMcpTools()
    expect(tools.length).toBeGreaterThan(50)
    for (const t of tools) expect(['read', 'write', 'admin'], t.name).toContain(t.capability)
    expect(tools.filter((t) => t.capability === 'admin').map((t) => t.name).sort()).toEqual(ADMIN_TOOLS)
    // Reading tools never need more than read.
    for (const name of ['read_note', 'search', 'browse_vault', 'read_file', 'find_symbols', 'graph', 'note_history', 'get_revision']) {
      expect(tools.find((t) => t.name === name)?.capability, name).toBe('read')
    }
  })

  it('the pin permission each tool needs: owner for the owner-gated tools, edit for the edit-gated ones, read for the rest', () => {
    const tools = listMcpTools()
    const named = (p: string) => tools.filter((t) => t.pinPermission === p).map((t) => t.name).sort()
    expect(named('owner')).toEqual(OWNER_TOOLS)
    expect(named('edit')).toEqual(EDIT_TOOLS)
    expect(named('read').length).toBe(tools.length - OWNER_TOOLS.length - EDIT_TOOLS.length)
  })

  it('GET /api/mcp-connections/tools lists every tool with its scope and capability', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const res = await app.inject({ method: 'GET', url: '/api/mcp-connections/tools', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(listMcpTools())

    const anonymous = await app.inject({ method: 'GET', url: '/api/mcp-connections/tools' })
    expect(anonymous.statusCode).toBe(401)
  })
})
