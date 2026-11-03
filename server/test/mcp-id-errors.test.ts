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
  const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
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
  const otherCookie = await loginCookie(app, other.email)
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'pinned-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'pinned-vault' } })).json<{ id: string }>().id
  strangerRepoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie: otherCookie }, body: { name: 'secret-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  strangerVaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: otherCookie }, body: { name: 'secret-vault' } })).json<{ id: string }>().id
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
      expect(r.json.error.code, tool).toBe('INVALID_ARGUMENT')
      expect(r.json.error.field, tool).toBe('repositoryId')
      expect(r.json.error.suggestions, tool).toEqual([`${repoId} (pinned-repo)`])
      expect(r.json.error.message, tool).toContain('omit it')
    }
  })

  it("another repository's id is refused with the pin named, and says nothing of that repository", async () => {
    const r = await call(repoPin, 'browse_repository', { repositoryId: strangerRepoId })
    expect(r.isError).toBe(true)
    expect(r.json.error.suggestions).toEqual([`${repoId} (pinned-repo)`])
    expect(JSON.stringify(r.json)).not.toContain('secret-repo')
  })
})

describe('a vault-pinned token', () => {
  it('a malformed id is refused naming the pinned vault', async () => {
    for (const [tool, args] of [['browse_vault', {}], ['read_note', { path: 'x' }], ['graph', {}]] as const) {
      const r = await call(vaultPin, tool, { ...args, vaultId: MISCOPIED })
      expect(r.json.error.code, tool).toBe('INVALID_ARGUMENT')
      expect(r.json.error.suggestions, tool).toEqual([`${vaultId} (pinned-vault)`])
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
})
