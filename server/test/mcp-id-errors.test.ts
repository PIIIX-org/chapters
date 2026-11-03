import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #1101: a mis-copied id must not cost a whole task. A pinned token may omit the id, and a wrong one is refused
// with the pin named; an account token's malformed or unknown id is refused with its own accessible ids as suggestions.

let app: FastifyInstance
let port: number
const clients: Client[] = []
let account: Client
let stranger: Client
let repoPin: Client
let vaultPin: Client
let repoId: string
let vaultId: string
let strangerRepoId: string
let strangerVaultId: string
let ownerCookie: string

type Err = { error: { code: string; message: string; field?: string; suggestions?: string[] } }

async function connect(email: string, body: Record<string, unknown>): Promise<Client> {
  const cookie = await loginCookie(app, email)
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: `ids-${clients.length}`, ...body } })
  const client = new Client({ name: 'ids', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }))
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: Err & Record<string, unknown> }> {
  resetRateLimits()
  const r = await client.callTool({ name, arguments: args })
  const text = (r.content as Array<{ text?: string }>)[0]?.text ?? ''
  return { isError: r.isError === true, json: JSON.parse(text) }
}

const MISCOPIED = '078fa67a-f20a-4e2b-8feb-14da-4bab614b'

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const a = app.server.address()
  port = typeof a === 'object' && a ? a.port : 0
  const user = await createActiveUser()
  const other = await createActiveUser()
  const cookie = await loginCookie(app, user.email)
  ownerCookie = cookie
  const otherCookie = await loginCookie(app, other.email)
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'pinned-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'pinned-vault' } })).json<{ id: string }>().id
  strangerRepoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie: otherCookie }, body: { name: 'secret-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  strangerVaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: otherCookie }, body: { name: 'secret-vault' } })).json<{ id: string }>().id
  await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/notes`, headers: { cookie }, body: { type: 'docs', name: 'probe', body: 'probe' } })
  await syncRepositoryFiles(repoId, [{ path: 'a.ts', content: 'export const a = 1\n' }], ['a.ts'])
  account = await connect(user.email, { scope: 'account' })
  stranger = await connect(other.email, { scope: 'account' })
  repoPin = await connect(user.email, { scope: 'repository', repositoryId: repoId })
  vaultPin = await connect(user.email, { scope: 'vault', vaultId })
}, 60_000)

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {})
  await app?.close()
})

describe('a repository-pinned token', () => {
  it('omits the id and gets its repository', async () => {
    const r = await call(repoPin, 'browse_repository', {})
    expect(r.isError).toBe(false)
    expect(JSON.stringify(r.json)).toContain('a.ts')
  })

  it('a malformed id is refused naming the pinned id and its name, on every repository tool family', async () => {
    for (const [tool, args] of [['browse_repository', {}], ['read_file', { path: 'a.ts' }], ['find_symbols', { query: 'a' }], ['search', { query: 'a' }], ['graph', {}]] as const) {
      const r = await call(repoPin, tool, { ...args, repositoryId: MISCOPIED })
      expect(r.isError, tool).toBe(true)
      expect(r.json.error.code, tool).toBe('TOOL_NOT_ALLOWED')
      expect(r.json.error.field, tool).toBe('repositoryId')
      expect(r.json.error.suggestions, tool).toEqual([`${repoId} (pinned-repo)`])
      expect(r.json.error.message, tool).toContain('omit it')
    }
  })

  it("another repository's id is refused with the pin named, and says nothing of that repository", async () => {
    const r = await call(repoPin, 'browse_repository', { repositoryId: strangerRepoId })
    expect(r.isError).toBe(true)
    expect(r.json.error.code).toBe('TOOL_NOT_ALLOWED')
    expect(r.json.error.suggestions).toEqual([`${repoId} (pinned-repo)`])
    expect(JSON.stringify(r.json)).not.toContain('secret-repo')
  })
})

describe('a vault-pinned token', () => {
  it('a malformed id is refused naming the pinned vault', async () => {
    for (const [tool, args] of [['browse_vault', {}], ['read_note', { path: 'x' }], ['graph', {}]] as const) {
      const r = await call(vaultPin, tool, { ...args, vaultId: MISCOPIED })
      expect(r.json.error.code, tool).toBe('TOOL_NOT_ALLOWED')
      expect(r.json.error.suggestions, tool).toEqual([`${vaultId} (pinned-vault)`])
    }
  })
})

describe('a pinned token names nothing of the account', () => {
  it('an id of the other kind, malformed or not, is the scope refusal with no suggestions and no account id or name', async () => {
    const cases: Array<[Client, string, Record<string, unknown>]> = [
      [vaultPin, 'browse_repository', { repositoryId: MISCOPIED }],
      [vaultPin, 'browse_repository', { repositoryId: strangerRepoId }],
      [vaultPin, 'search', { query: 'a', repositoryId: repoId }],
      [repoPin, 'browse_vault', { vaultId: MISCOPIED }],
      [repoPin, 'read_note', { path: 'x', vaultId: vaultId }],
    ]
    for (const [client, tool, args] of cases) {
      const r = await call(client, tool, args)
      expect(r.json.error.code, tool).toBe('TOOL_NOT_ALLOWED')
      expect(r.json.error.suggestions, tool).toBeUndefined()
      for (const hidden of [repoId, vaultId, strangerRepoId, strangerVaultId, 'pinned-repo', 'pinned-vault', 'secret']) expect(JSON.stringify(r.json), `${tool} ${hidden}`).not.toContain(hidden)
    }
  })

  it('with both ids given, a vault-pinned token is refused for the repository one, a repository-pinned token for the vault one', async () => {
    expect((await call(vaultPin, 'search', { query: 'a', vaultId, repositoryId: repoId })).json.error.code).toBe('TOOL_NOT_ALLOWED')
    expect((await call(repoPin, 'search', { query: 'a', vaultId, repositoryId: repoId })).json.error.code).toBe('TOOL_NOT_ALLOWED')
  })
})

describe('access to the id families (shared, revoked, other account; unpinned and pinned)', () => {
  const FAMILIES: Array<[string, Record<string, unknown>, 'repository' | 'vault']> = [
    ['search', { query: 'a' }, 'repository'],
    ['read_file', { path: 'a.ts' }, 'repository'],
    ['browse_repository', {}, 'repository'],
    ['find_symbols', { query: 'a' }, 'repository'],
    ['read_note', { path: 'docs/probe' }, 'vault'],
  ]
  const idOf = (kind: 'repository' | 'vault') => (kind === 'repository' ? { repositoryId: repoId } : { vaultId })

  it('the owner reads; another account is refused alike for a real and a missing id, naming only its own ids', async () => {
    for (const [tool, args, kind] of FAMILIES) {
      const real = await call(stranger, tool, { ...args, ...idOf(kind) })
      const missing = await call(stranger, tool, { ...args, [kind === 'repository' ? 'repositoryId' : 'vaultId']: '00000000-0000-4000-8000-000000000000' })
      expect(real.json, tool).toEqual(missing.json)
      expect(real.json.error.code, tool).toBe('NOT_FOUND')
      expect(JSON.stringify(real.json), tool).not.toContain('pinned-')
    }
  })

  it('a shared account reads with an unpinned and a pinned token; after the revoke both are refused, naming none of the owner', async () => {
    const member = await createActiveUser()
    const share = await app.inject({ method: 'POST', url: `/api/repositories/${repoId}/shares`, headers: { cookie: ownerCookie }, body: { granteeType: 'user', granteeId: member.id } })
    const vshare = await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/shares`, headers: { cookie: ownerCookie }, body: { granteeType: 'user', granteeId: member.id, permission: 'read' } })
    const open = await connect(member.email, { scope: 'account' })
    const pinnedRepo = await connect(member.email, { scope: 'repository', repositoryId: repoId })
    const pinnedVault = await connect(member.email, { scope: 'vault', vaultId })
    for (const [tool, args, kind] of FAMILIES) {
      const pinned = kind === 'repository' ? pinnedRepo : pinnedVault
      expect((await call(open, tool, { ...args, ...idOf(kind) })).json.error?.code, `${tool} shared`).not.toBe('NOT_FOUND')
      expect((await call(pinned, tool, args)).json.error?.code, `${tool} shared, pinned`).not.toBe('NOT_FOUND')
    }
    await app.inject({ method: 'DELETE', url: `/api/repositories/${repoId}/shares/${share.json<{ id: string }>().id}`, headers: { cookie: ownerCookie } })
    await app.inject({ method: 'DELETE', url: `/api/vaults/${vaultId}/shares/${vshare.json<{ id: string }>().id}`, headers: { cookie: ownerCookie } })
    for (const [tool, args, kind] of FAMILIES) {
      const pinned = kind === 'repository' ? pinnedRepo : pinnedVault
      for (const r of [await call(open, tool, { ...args, ...idOf(kind) }), await call(pinned, tool, args)]) {
        expect(r.json.error.code, `${tool} revoked`).toBe('NOT_FOUND')
        expect(JSON.stringify(r.json), `${tool} revoked`).not.toMatch(/pinned-(repo|vault)/)
      }
    }
  })
})

describe('an account token', () => {
  it('a malformed id is INVALID_ARGUMENT with the accessible ids and names', async () => {
    const r = await call(account, 'browse_repository', { repositoryId: MISCOPIED })
    expect(r.json.error.code).toBe('INVALID_ARGUMENT')
    expect(r.json.error.suggestions).toContain(`${repoId} (pinned-repo)`)
    expect(JSON.stringify(r.json)).not.toContain(strangerRepoId)
    const v = await call(account, 'browse_vault', { vaultId: MISCOPIED })
    expect(v.json.error.suggestions).toContain(`${vaultId} (pinned-vault)`)
    expect(JSON.stringify(v.json)).not.toContain(strangerVaultId)
  })

  it('an unknown id and an id the account cannot see answer alike, naming only its own ids', async () => {
    const unknown = await call(stranger, 'browse_repository', { repositoryId: repoId })
    const missing = await call(stranger, 'browse_repository', { repositoryId: '00000000-0000-4000-8000-000000000000' })
    expect(unknown.json.error.code).toBe('NOT_FOUND')
    expect(unknown.json).toEqual(missing.json)
    expect(unknown.json.error.suggestions).toEqual([`${strangerRepoId} (secret-repo)`])
    expect(JSON.stringify(unknown.json)).not.toContain('pinned-repo')
  })

  it('lists at most 5 suggestions', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    for (let i = 0; i < 7; i++) await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: `many-${i}` } })
    const many = await connect(user.email, { scope: 'account' })
    const r = await call(many, 'browse_vault', { vaultId: MISCOPIED })
    expect(r.json.error.suggestions).toHaveLength(5)
  })

  it('suggestions are the same on every refusal, by name then id, whatever order the vaults were made in', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    for (const name of ['v-g', 'v-c', 'v-a', 'v-f', 'v-b', 'v-e', 'v-d']) await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name } })
    const many = await connect(user.email, { scope: 'account' })
    const first = await call(many, 'browse_vault', { vaultId: MISCOPIED })
    const second = await call(many, 'browse_vault', { vaultId: 'also-not-a-uuid' })
    expect(first.json.error.suggestions).toEqual(second.json.error.suggestions)
    expect(first.json.error.suggestions!.map((x) => x.replace(/^.* \((.*)\)$/, '$1'))).toEqual(['v-a', 'v-b', 'v-c', 'v-d', 'v-e'])
  })
})
