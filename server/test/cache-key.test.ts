// #680 (ADR-004 §2.9): a cache key changes exactly when the answer it names
// could change, and two callers who may see different things never share one.
// The first block checks each field of the key without a database; the second
// reads real epochs around writes and reads.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { sql as pg } from '../src/db/client.js'
import { cacheCaller, cacheKey, readEpochs, type CacheCaller, type CacheResources, type Epochs } from '../src/cache/key.js'
import type * as ExtractionQueue from '../src/repositories/extraction-queue.js'
import type { McpAuth } from '../src/vaults/mcp-connection-routes.js'
import { createActiveUser, loginCookie } from './helpers.js'

const derived = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('../src/repositories/extraction-queue.js', async (original) => {
  const real = await original<typeof ExtractionQueue>()
  return { ...real, versionsKey: () => derived.value ?? real.versionsKey() }
})

const V1 = '00000000-0000-4000-8000-000000000001'
const V2 = '00000000-0000-4000-8000-000000000002'
const R1 = '00000000-0000-4000-8000-0000000000a1'
const U1 = '00000000-0000-4000-8000-0000000000f1'
const U2 = '00000000-0000-4000-8000-0000000000f2'

const caller: CacheCaller = { userId: U1, scope: 'account', access: 'read', profile: 'reader', allowedTools: null }
const resources: CacheResources = { vaultIds: [V1, V2], repositoryIds: [R1] }
const epochs: Epochs = { permission: '7', vaults: { [V1]: '3', [V2]: '5' }, repositories: { [R1]: '11' } }
const args = { query: 'cache epochs', vaultId: V1, limit: 5 }
const key = (over: { tool?: string; args?: Record<string, unknown>; resources?: CacheResources; epochs?: Epochs; caller?: CacheCaller } = {}) =>
  cacheKey(over.tool ?? 'search', over.args ?? args, over.resources ?? resources, over.epochs ?? epochs, over.caller ?? caller)

describe('cacheKey: equal exactly when the answer must be equal (#680)', () => {
  it('ignores what cannot change the answer: argument order, resource order and repeats, cursor, budget, allow-list order', () => {
    const base = key()
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(key({ args: { limit: 5, query: 'cache epochs', vaultId: V1 } })).toBe(base)
    expect(key({ args: { ...args, cursor: 'abc', budget_tokens: 900 } })).toBe(base)
    expect(key({ resources: { vaultIds: [V2, V1, V2], repositoryIds: [R1] } })).toBe(base)
    expect(key({ epochs: { ...epochs, vaults: { [V2]: '5', [V1]: '3', [U2]: '1' } } })).toBe(base)
    const listed = key({ caller: { ...caller, allowedTools: ['search', 'read_note'] } })
    expect(key({ caller: { ...caller, allowedTools: ['read_note', 'search'] } })).toBe(listed)
  })

  it('changes with every field that can change the answer or who may see it', () => {
    const variants: Record<string, string | null> = {
      base: key(),
      tool: key({ tool: 'find_symbols' }),
      'an argument value': key({ args: { ...args, query: 'other' } }),
      'an argument added': key({ args: { ...args, symbols: true } }),
      'another account': key({ caller: { ...caller, userId: U2 } }),
      'a pinned connection': key({ caller: { ...caller, scope: `vault:${V1}` } }),
      'another access level': key({ caller: { ...caller, access: 'write' } }),
      'another profile': key({ caller: { ...caller, profile: 'admin' } }),
      'an allow-list': key({ caller: { ...caller, allowedTools: ['search'] } }),
      'another allow-list': key({ caller: { ...caller, allowedTools: ['search', 'graph'] } }),
      'a resource less': key({ resources: { vaultIds: [V1], repositoryIds: [R1] } }),
      'a vault epoch': key({ epochs: { ...epochs, vaults: { ...epochs.vaults, [V2]: '6' } } }),
      'a repository epoch': key({ epochs: { ...epochs, repositories: { [R1]: '12' } } }),
      'the permission epoch': key({ epochs: { ...epochs, permission: '8' } }),
    }
    derived.value = '5:fake+text2+chunk2'
    variants['the derived versions'] = key()
    derived.value = null
    expect(variants['base']).toBe(key())
    const values = Object.values(variants)
    expect(values.every((v) => typeof v === 'string')).toBe(true)
    expect(new Set(values).size, JSON.stringify(variants, null, 1)).toBe(values.length)
  })

  it('refuses (null) when an epoch of a resource is missing: nothing is cached for a scope it cannot version', () => {
    expect(key({ epochs: { ...epochs, vaults: { [V1]: '3' } } })).toBeNull()
    expect(key({ epochs: { ...epochs, repositories: {} } })).toBeNull()
  })

  it('cacheCaller takes the account, the connection scope with its pin, access, profile and allow-list from the token', () => {
    const auth = (connection: Partial<McpAuth['connection']>) =>
      ({
        user: { id: U1 },
        connection: { scope: 'account', vaultId: null, repositoryId: null, access: 'read', profile: 'reader', allowedTools: null, ...connection },
      }) as unknown as McpAuth
    expect(cacheCaller(auth({}))).toEqual(caller)
    expect(cacheCaller(auth({ scope: 'vault', vaultId: V1, access: 'write', allowedTools: ['search', 'graph'] }))).toEqual({
      ...caller,
      scope: `vault:${V1}`,
      access: 'write',
      allowedTools: ['graph', 'search'],
    })
    expect(cacheCaller(auth({ scope: 'repository', repositoryId: R1 })).scope).toBe(`repo:${R1}`)
  })
})

describe('readEpochs + cacheKey on a real instance: writes in scope move the key, reads and writes elsewhere do not (#680)', () => {
  let app: FastifyInstance
  let cookie: string
  let ownerId: string
  let a: string
  let b: string

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    const owner = await createActiveUser()
    ownerId = owner.id
    cookie = await loginCookie(app, owner.email)
    a = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'key A' } })).json().id
    b = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'key B' } })).json().id
  })
  afterAll(async () => app.close())

  const ownerCaller = (): CacheCaller => ({ userId: ownerId, scope: 'account', access: 'admin', profile: 'admin', allowedTools: null })
  async function keyOver(vaultIds: string[], who = ownerCaller()): Promise<string | null> {
    const scope = { vaultIds, repositoryIds: [] }
    return cacheKey('search', { query: 'epochs' }, scope, await readEpochs(scope), who)
  }
  async function write(vaultId: string, name: string) {
    const res = await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/notes`, headers: { cookie }, body: { type: 'docs', name, body: `${name}\n` } })
    expect(res.statusCode).toBe(200)
  }

  it('moves with a write in its scope only; a read leaves it', async () => {
    await write(a, 'first')
    const k0 = await keyOver([a])
    const both0 = await keyOver([a, b])
    expect(k0).not.toBeNull()
    expect((await app.inject({ method: 'GET', url: `/api/vaults/${a}/notes`, headers: { cookie } })).statusCode).toBe(200)
    expect(await keyOver([a])).toBe(k0)
    await write(b, 'elsewhere')
    expect(await keyOver([a])).toBe(k0)
    expect(await keyOver([a, b])).not.toBe(both0)
    await write(a, 'second')
    expect(await keyOver([a])).not.toBe(k0)
  })

  it('moves with a share change (the permission epoch), and differs per account', async () => {
    const k0 = await keyOver([a])
    const other = await createActiveUser()
    expect(await keyOver([a], { ...ownerCaller(), userId: other.id })).not.toBe(k0)
    await pg`INSERT INTO vault_shares (vault_id, grantee_type, grantee_id, permission) VALUES (${a}, 'user', ${other.id}, 'read')`
    expect(await keyOver([a])).not.toBe(k0)
  })

  it('refuses a scope with no epoch (a vault that does not exist)', async () => {
    expect(await keyOver([a, '00000000-0000-4000-8000-00000000dead'])).toBeNull()
  })
})
