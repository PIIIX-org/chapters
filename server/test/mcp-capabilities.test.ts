// MCP token capabilities set at mint time (#548, #549): an access level
// (read < write < admin), an optional tool allow-list and an optional expiry.
// A token pinned to one vault or repository gets `write` unless its owner
// grants `admin` at mint time, so by default it cannot share, update, trash or
// purge its pin, or erase history.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db, sql } from '../src/db/client.js'
import { mcpConnections } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>

let app: FastifyInstance
let baseUrl: string
let ownerCookie: string
let memberCookie: string
let memberId: string
let acct: Client
const clients: Client[] = []

const CAPABILITY_DENIAL = /needs the (write|admin) capability/

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'capability-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function must<T>(client: Client, name: string, args: Args): Promise<T> {
  const r = await call(client, name, args)
  if (r.isError) throw new Error(`${name} failed: ${r.text}`)
  return JSON.parse(r.text) as T
}

async function mintAs(cookie: string, body: Args) {
  return app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body })
}

async function mint(body: Args): Promise<{ id: string; token: string }> {
  const res = await mintAs(ownerCookie, body)
  if (res.statusCode !== 200) throw new Error(`mint failed: ${res.statusCode} ${res.body}`)
  return res.json()
}

async function listed(id: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: '/api/mcp-connections', headers: { cookie: ownerCookie } })
  return (res.json() as Array<Record<string, unknown>>).find((c) => c.id === id)!
}

/** A vault the owner owns, with a note, a trashed note, a revision and a share. */
async function vaultFixture(name: string) {
  const vault = await must<{ id: string }>(acct, 'create_vault', { name })
  await must(acct, 'create_note', { vaultId: vault.id, type: 'docs', name: 'kept', body: 'kept' })
  await must(acct, 'create_note', { vaultId: vault.id, type: 'docs', name: 'trashed', body: 'trashed' })
  await must(acct, 'delete_note', { vaultId: vault.id, path: 'docs/trashed' })
  const trash = await must<Array<{ id: string }>>(acct, 'list_trash', { vaultId: vault.id })
  const revisions = await must<Array<{ id: string }>>(acct, 'note_history', { vaultId: vault.id, path: 'docs/kept' })
  await must(acct, 'share_vault', { vaultId: vault.id, granteeType: 'user', granteeId: memberId, permission: 'edit' })
  const shares = await must<Array<{ id: string }>>(acct, 'list_vault_shares', { vaultId: vault.id })
  return { id: vault.id, trashedId: trash[0]!.id, revisionId: revisions[0]!.id, shareId: shares[0]!.id }
}

async function repoFixture(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/repositories',
    headers: { cookie: ownerCookie },
    body: { name, ingestionMethod: 'agent_push' },
  })
  const { id } = res.json() as { id: string }
  await syncRepositoryFiles(id, [{ path: 'src/a.ts', content: 'export const a = 1' }], ['src/a.ts'])
  return id
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const member = await createActiveUser()
  memberId = member.id
  ownerCookie = await loginCookie(app, owner.email)
  memberCookie = await loginCookie(app, member.email)
  acct = await mcpClient((await mint({ name: 'cap-account', scope: 'account' })).token)
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('MCP token capabilities (#548)', () => {
  it('a read-only token reads but cannot write', async () => {
    const v = await vaultFixture('cap-read-only')
    const minted = await mint({ name: 'cap-reader', scope: 'vault', vaultId: v.id, access: 'read' })
    expect(await listed(minted.id)).toMatchObject({ access: 'read', allowedTools: null })
    const reader = await mcpClient(minted.token)

    const read = await call(reader, 'read_note', { path: 'docs/kept' })
    expect(read.isError, read.text).toBe(false)
    const browse = await call(reader, 'browse_vault', {})
    expect(browse.isError, browse.text).toBe(false)

    for (const [tool, args] of [
      ['create_note', { type: 'docs', name: 'nope', body: 'x' }],
      ['edit_note', { path: 'docs/kept', body: 'overwritten' }],
      ['delete_note', { path: 'docs/kept' }],
    ] as const) {
      const r = await call(reader, tool, args)
      expect(r.isError, `${tool}: ${r.text}`).toBe(true)
      expect(r.text).toMatch(/needs the write capability; this connection has read access/)
    }
    const note = await must<{ body: string }>(acct, 'read_note', { vaultId: v.id, path: 'docs/kept' })
    expect(note.body.trim()).toBe('kept')
  })

  it('a tool allow-list blocks every other tool, and unknown tools are refused at mint time', async () => {
    const v = await vaultFixture('cap-allow-list')
    const minted = await mint({
      name: 'cap-allow',
      scope: 'vault',
      vaultId: v.id,
      access: 'write',
      allowedTools: ['read_note', 'create_note'],
    })
    expect(await listed(minted.id)).toMatchObject({ access: 'write', allowedTools: ['read_note', 'create_note'] })
    const limited = await mcpClient(minted.token)

    expect((await call(limited, 'read_note', { path: 'docs/kept' })).isError).toBe(false)
    expect((await call(limited, 'create_note', { type: 'docs', name: 'allowed', body: 'x' })).isError).toBe(false)
    for (const tool of ['search', 'browse_vault', 'edit_note']) {
      const r = await call(limited, tool, tool === 'search' ? { query: 'kept' } : tool === 'edit_note' ? { path: 'docs/kept', body: 'y' } : {})
      expect(r.isError, `${tool}: ${r.text}`).toBe(true)
      expect(r.text).toMatch(new RegExp(`${tool} is not in this connection's tool allow-list`))
    }

    const unknown = await mintAs(ownerCookie, { name: 'cap-bad', scope: 'account', allowedTools: ['read_note', 'drop_database'] })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json()).toMatchObject({ error: expect.stringMatching(/drop_database/) })
  })

  it('expiry is set at mint time and an expired token is rejected', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString()
    const minted = await mint({ name: 'cap-expiring', scope: 'account', expiresAt })
    expect(new Date(String((await listed(minted.id)).expiresAt)).toISOString()).toBe(expiresAt)
    const client = await mcpClient(minted.token)
    expect((await call(client, 'list_vaults', {})).isError).toBe(false)

    await db.update(mcpConnections).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(mcpConnections.id, minted.id))
    resetRateLimits()
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${minted.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(401)

    const past = await mintAs(ownerCookie, { name: 'cap-past', scope: 'account', expiresAt: new Date(Date.now() - 60_000).toISOString() })
    expect(past.statusCode).toBe(400)
  })

  it('an account token minted without an access level keeps every tool (admin)', async () => {
    const minted = await mint({ name: 'cap-default-account', scope: 'account' })
    expect(await listed(minted.id)).toMatchObject({ access: 'admin', allowedTools: null, expiresAt: null })
  })

  it('the access column has no database default: every insert names its level (#641)', async () => {
    // Migration 0019 left DEFAULT 'write' while the route gives account tokens admin; 0020 drops it.
    const columns = await sql`
      select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'mcp_connections' and column_name = 'access'`
    expect([...columns]).toEqual([{ column_default: null }])
  })
})

describe('Pinned tokens and admin tools (#549)', () => {
  it('a vault-pinned token cannot share, update, trash or purge its vault or erase history by default', async () => {
    const v = await vaultFixture('cap-pinned-default')
    const minted = await mint({ name: 'cap-pinned', scope: 'vault', vaultId: v.id })
    expect(await listed(minted.id)).toMatchObject({ access: 'write' })
    const pinned = await mcpClient(minted.token)

    const denied: Array<[string, Args]> = [
      ['share_vault', { granteeType: 'user', granteeId: memberId, permission: 'read' }],
      ['revoke_vault_share', { shareId: v.shareId }],
      ['update_vault', { name: 'renamed by token' }],
      ['purge_note', { noteId: v.trashedId }],
      ['purge_revision', { revisionId: v.revisionId }],
      ['delete_vault', {}],
    ]
    for (const [tool, args] of denied) {
      const r = await call(pinned, tool, args)
      expect(r.isError, `${tool}: ${r.text}`).toBe(true)
      expect(r.text).toMatch(new RegExp(`${tool} needs the admin capability; this connection has write access`))
    }
    // Nothing changed: the share, the trashed note, the revision and the vault are all still there.
    expect((await must<Array<{ id: string }>>(acct, 'list_vault_shares', { vaultId: v.id })).map((s) => s.id)).toEqual([v.shareId])
    expect((await must<Array<{ id: string }>>(acct, 'list_trash', { vaultId: v.id })).map((t) => t.id)).toContain(v.trashedId)
    expect((await must<Array<{ id: string }>>(acct, 'note_history', { vaultId: v.id, path: 'docs/kept' })).map((r) => r.id)).toContain(
      v.revisionId,
    )
    expect((await must<Array<{ id: string }>>(acct, 'list_vaults', {})).map((x) => x.id)).toContain(v.id)

    // Writing inside the pin still works.
    const created = await call(pinned, 'create_note', { type: 'docs', name: 'written', body: 'x' })
    expect(created.isError, created.text).toBe(false)
  })

  it('with admin granted by the owner at mint time, a vault-pinned token can share, purge and trash its vault', async () => {
    const v = await vaultFixture('cap-pinned-admin')
    const minted = await mint({ name: 'cap-pinned-admin', scope: 'vault', vaultId: v.id, access: 'admin' })
    expect(await listed(minted.id)).toMatchObject({ access: 'admin' })
    const pinned = await mcpClient(minted.token)

    for (const [tool, args] of [
      ['revoke_vault_share', { shareId: v.shareId }],
      ['share_vault', { granteeType: 'user', granteeId: memberId, permission: 'read' }],
      ['purge_note', { noteId: v.trashedId }],
      ['purge_revision', { revisionId: v.revisionId }],
      ['delete_vault', {}],
    ] as Array<[string, Args]>) {
      const r = await call(pinned, tool, args)
      expect(r.isError, `${tool}: ${r.text}`).toBe(false)
    }
    expect((await must<Array<{ id: string }>>(acct, 'list_vaults', {})).map((x) => x.id)).not.toContain(v.id)
  })

  it('only the owner of the pinned vault can mint an admin token for it', async () => {
    const v = await vaultFixture('cap-pinned-member')
    // The member has edit access through the share, so a write token is fine.
    const write = await mintAs(memberCookie, { name: 'member-write', scope: 'vault', vaultId: v.id })
    expect(write.statusCode).toBe(200)
    const admin = await mintAs(memberCookie, { name: 'member-admin', scope: 'vault', vaultId: v.id, access: 'admin' })
    expect(admin.statusCode).toBe(403)
  })

  it('a repository-pinned token cannot share, update or delete its repository without admin', async () => {
    const repositoryId = await repoFixture('cap-pinned-repo')
    const minted = await mint({ name: 'cap-repo', scope: 'repository', repositoryId })
    const pinned = await mcpClient(minted.token)

    expect((await call(pinned, 'browse_repository', {})).isError).toBe(false)
    for (const [tool, args] of [
      ['share_repository', { granteeType: 'user', granteeId: memberId }],
      ['update_repository', { mergeable: true }],
      ['delete_repository', {}],
    ] as Array<[string, Args]>) {
      const r = await call(pinned, tool, args)
      expect(r.isError, `${tool}: ${r.text}`).toBe(true)
      expect(r.text).toMatch(CAPABILITY_DENIAL)
    }
    expect((await must<Array<{ id: string }>>(acct, 'list_repositories', {})).map((r) => r.id)).toContain(repositoryId)

    const adminToken = await mint({ name: 'cap-repo-admin', scope: 'repository', repositoryId, access: 'admin' })
    const admin = await mcpClient(adminToken.token)
    const deleted = await call(admin, 'delete_repository', {})
    expect(deleted.isError, deleted.text).toBe(false)
    expect((await must<Array<{ id: string }>>(acct, 'list_repositories', {})).map((r) => r.id)).not.toContain(repositoryId)
  })
})

describe("A pinned token is capped at its minter's permission on the pin (#649)", () => {
  async function listedNames(client: Client): Promise<string[]> {
    resetRateLimits()
    return (await client.listTools()).tools.map((t) => t.name)
  }

  it('a member with a read-only share cannot mint a write or admin token, and the default is read', async () => {
    const vault = await must<{ id: string }>(acct, 'create_vault', { name: 'cap-read-share' })
    await must(acct, 'share_vault', { vaultId: vault.id, granteeType: 'user', granteeId: memberId, permission: 'read' })

    const write = await mintAs(memberCookie, { name: 'reader-write', scope: 'vault', vaultId: vault.id, access: 'write' })
    expect(write.statusCode).toBe(403)
    expect(write.json()).toEqual({
      error: 'write access on a vault-pinned connection requires edit permission on the vault; you have read permission, so mint a read token',
    })
    const admin = await mintAs(memberCookie, { name: 'reader-admin', scope: 'vault', vaultId: vault.id, access: 'admin' })
    expect(admin.statusCode).toBe(403)
    expect(admin.json()).toEqual({ error: 'admin access on a vault-pinned connection requires owning the vault' })

    // No level asked for: the pin default (write) is lowered to read, not refused.
    const byDefault = await mintAs(memberCookie, { name: 'reader-default', scope: 'vault', vaultId: vault.id })
    expect(byDefault.statusCode).toBe(200)
    const minted: { id: string; token: string; access: string } = byDefault.json()
    expect(minted.access).toBe('read')
    const reader = await mcpClient(minted.token)
    const names = await listedNames(reader)
    expect(names).toContain('read_note')
    expect(names).not.toContain('create_note')
    // Read-level tools whose handler needs edit permission are not listed either, and still refuse.
    for (const editGated of ['list_trash', 'note_history', 'export_vault']) expect(names).not.toContain(editGated)
    expect(await call(reader, 'list_trash', {})).toEqual({ isError: true, text: 'Error: not found' })

    const read = await mintAs(memberCookie, { name: 'reader-read', scope: 'vault', vaultId: vault.id, access: 'read' })
    expect(read.statusCode).toBe(200)
  })

  it('a read-only share through a team caps the token the same way', async () => {
    const vault = await must<{ id: string }>(acct, 'create_vault', { name: 'cap-team-read-share' })
    const team = await must<{ id: string }>(acct, 'create_team', { name: 'cap-team-readers' })
    await must(acct, 'add_team_member', { teamId: team.id, userId: memberId })
    await must(acct, 'share_vault', { vaultId: vault.id, granteeType: 'team', granteeId: team.id, permission: 'read' })

    const write = await mintAs(memberCookie, { name: 'team-reader-write', scope: 'vault', vaultId: vault.id, access: 'write' })
    expect(write.statusCode).toBe(403)
    const byDefault = await mintAs(memberCookie, { name: 'team-reader-default', scope: 'vault', vaultId: vault.id })
    expect(byDefault.statusCode).toBe(200)
    expect(byDefault.json()).toMatchObject({ access: 'read' })
  })

  it('a write token a read-only member already holds (0019 set pinned tokens to write) lists only what that member can call', async () => {
    const vault = await must<{ id: string }>(acct, 'create_vault', { name: 'cap-legacy-write' })
    await must(acct, 'share_vault', { vaultId: vault.id, granteeType: 'user', granteeId: memberId, permission: 'read' })
    const minted: { id: string; token: string } = (
      await mintAs(memberCookie, { name: 'legacy-write', scope: 'vault', vaultId: vault.id })
    ).json()
    // What migration 0019 (and a restore of an older dump) left on every pinned token.
    await db.update(mcpConnections).set({ access: 'write' }).where(eq(mcpConnections.id, minted.id))
    const legacy = await mcpClient(minted.token)

    const names = await listedNames(legacy)
    expect(names).toContain('read_note')
    for (const hidden of ['create_note', 'edit_note', 'delete_note', 'list_trash', 'note_history', 'export_vault', 'list_vault_shares']) {
      expect(names).not.toContain(hidden)
    }
    // A write tool that needs only read permission stays listed, and works.
    expect(names).toContain('set_vault_graph_preference')
    expect((await call(legacy, 'set_vault_graph_preference', { include: false })).isError).toBe(false)
    expect(await call(legacy, 'create_note', { type: 'docs', name: 'nope', body: 'x' })).toEqual({ isError: true, text: 'Error: not found' })
  })

  it("tools/list follows an ownership transfer on the next request (both users' pinned tokens)", async () => {
    const v = await vaultFixture('cap-transfer')
    const ownerClient = await mcpClient((await mint({ name: 'transfer-old-owner', scope: 'vault', vaultId: v.id })).token)
    const memberToken: { token: string } = (await mintAs(memberCookie, { name: 'transfer-new-owner', scope: 'vault', vaultId: v.id })).json()
    const memberClient = await mcpClient(memberToken.token)
    expect(await listedNames(ownerClient)).toContain('list_vault_shares')
    expect(await listedNames(memberClient)).not.toContain('list_vault_shares')

    const transfer = await app.inject({
      method: 'POST',
      url: `/api/vaults/${v.id}/transfer`,
      headers: { cookie: ownerCookie },
      body: { newOwnerId: memberId },
    })
    expect(transfer.statusCode).toBe(200)

    expect(await listedNames(memberClient)).toContain('list_vault_shares')
    // The old owner has no share on the vault: every tool of the pin would refuse, so none is listed.
    expect(await listedNames(ownerClient)).toEqual([])
    expect(await call(ownerClient, 'read_note', { path: 'docs/kept' })).toEqual({ isError: true, text: 'Error: not found' })
  })

  it("share-listing and other owner-only tools are not listed for a non-owner's pinned token", async () => {
    const v = await vaultFixture('cap-owner-only-listing')
    // The member has edit through the share: a write token, which lists write tools.
    const memberToken: { token: string } = (await mintAs(memberCookie, { name: 'member-pinned', scope: 'vault', vaultId: v.id })).json()
    const memberClient = await mcpClient(memberToken.token)
    const memberNames = await listedNames(memberClient)
    expect(memberNames).toContain('create_note')
    expect(memberNames).not.toContain('list_vault_shares')
    // Still registered: the call answers why.
    const refused = await call(memberClient, 'list_vault_shares', {})
    expect(refused).toEqual({ isError: true, text: 'Error: owner permission required' })

    // The owner's token with the same access lists it, and the call works.
    const ownerClient = await mcpClient((await mint({ name: 'owner-pinned', scope: 'vault', vaultId: v.id })).token)
    expect(await listedNames(ownerClient)).toContain('list_vault_shares')
    expect((await call(ownerClient, 'list_vault_shares', {})).isError).toBe(false)

    const repositoryId = await repoFixture('cap-owner-only-repo')
    await must(acct, 'share_repository', { repositoryId, granteeType: 'user', granteeId: memberId })
    // A repository share has no read-only tier: a viewer's token keeps the write default.
    const viewerMint = await mintAs(memberCookie, { name: 'viewer-pinned', scope: 'repository', repositoryId })
    expect(viewerMint.statusCode).toBe(200)
    const viewerToken: { token: string; access: string } = viewerMint.json()
    expect(viewerToken.access).toBe('write')
    const viewerNames = await listedNames(await mcpClient(viewerToken.token))
    expect(viewerNames).toContain('sync_repository')
    expect(viewerNames).not.toContain('list_repository_shares')
    const repoOwner = await mcpClient((await mint({ name: 'owner-repo-pinned', scope: 'repository', repositoryId })).token)
    expect(await listedNames(repoOwner)).toContain('list_repository_shares')
  })
})
