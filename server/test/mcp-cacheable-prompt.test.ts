// A cacheable prompt (#681): what a token is sent before its first call
// (`initialize`, `tools/list`, `prompts/list`) opens every agent prompt, and
// model providers bill a repeated prefix at a fraction of the price only if
// its bytes repeat. So these answers are the same bytes for every token of
// one profile and scope, whoever minted it, whichever vault it is pinned to
// and whenever it calls: no id, name, date or count of the token's own.
// `serverInfo.version` carries a hash of the profile's definitions
// (definitions-version.ts), at no cost to the reader budget.
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
type Profile = 'reader' | 'writer' | 'admin'

const PROFILES = ['reader', 'writer', 'admin'] as const

let app: FastifyInstance
let baseUrl: string
/** Two accounts, each with a vault of its own. */
const accounts: Array<{ cookie: string; vaultId: string }> = []

async function post(cookie: string, url: string, body: Args): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'POST', url, headers: { cookie }, body })
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`)
  return res.json()
}

/** The raw JSON-RPC answer bytes of one request. */
async function rpc(token: string, method: string, params: Args = {}): Promise<string> {
  resetRateLimits()
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`${method}: ${res.status} ${text}`)
  return text
}

const INITIALIZE = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cacheable-prompt-test', version: '0.0.0' } }

const InitializeAnswer = z.object({ result: z.object({ serverInfo: z.object({ version: z.string() }), instructions: z.string() }) })
/** A list answer; `result` is absent when the method is refused. */
const ListAnswer = z.object({ result: z.unknown().optional() })

/** What a session is sent before its first call, as raw bytes. */
async function session(token: string, profile: Profile) {
  const initialize = await rpc(token, 'initialize', INITIALIZE)
  const tools = await rpc(token, 'tools/list')
  // A reader token has no prompts capability (#428): prompts/list is refused, the same way every time.
  const prompts = await rpc(token, 'prompts/list')
  if (profile !== 'reader') expect(JSON.parse(prompts), `${profile} prompts/list`).toHaveProperty('result.prompts')
  return { initialize, tools, prompts }
}

async function mint(account: { cookie: string; vaultId: string }, profile: Profile, scope: 'account' | 'vault'): Promise<string> {
  const body = { name: `cacheable-${profile}-${scope}-${Math.random()}`, scope, profile, ...(scope === 'vault' ? { vaultId: account.vaultId } : {}) }
  const token = (await post(account.cookie, '/api/mcp-connections', body)).token
  if (typeof token !== 'string') throw new Error('mint answered no token')
  return token
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  for (const name of ['cacheable-a', 'cacheable-b']) {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const vaultId = (await post(cookie, '/api/vaults', { name: `${name}-${Math.random()}` })).id
    if (typeof vaultId !== 'string') throw new Error('vault create answered no id')
    accounts.push({ cookie, vaultId })
  }
}, 60_000)

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  await app.close()
})

describe('a cacheable prompt per profile (#681)', () => {
  for (const profile of PROFILES) {
    for (const scope of ['account', 'vault'] as const) {
      it(`answers ${profile} ${scope} tokens of two accounts, on two dates, with the same bytes`, async () => {
        const [a, b] = [await mint(accounts[0]!, profile, scope), await mint(accounts[1]!, profile, scope)]
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-01-01T09:00:00Z'))
        const first = await session(a, profile)
        vi.setSystemTime(new Date('2027-07-15T23:59:59Z'))
        const second = await session(b, profile)
        expect(second.initialize).toBe(first.initialize)
        expect(second.tools).toBe(first.tools)
        expect(second.prompts).toBe(first.prompts)
        for (const { vaultId } of accounts) {
          for (const bytes of Object.values(first)) expect(bytes).not.toContain(vaultId)
        }
      })
    }
  }

  it('versions each profile by a hash of its definitions, outside the listed text', async () => {
    const versions = new Set<string>()
    for (const profile of PROFILES) {
      const token = await mint(accounts[0]!, profile, 'account')
      const { initialize, tools, prompts } = await session(token, profile)
      const init = InitializeAnswer.parse(JSON.parse(initialize))
      const promptsResult = ListAnswer.parse(JSON.parse(prompts)).result
      const hash = createHash('sha256')
        .update(JSON.stringify(ListAnswer.parse(JSON.parse(tools)).result))
        .update('\0')
        .update(promptsResult === undefined ? '' : JSON.stringify(promptsResult))
        .update('\0')
        .update(init.result.instructions)
        .digest('hex')
      const version = init.result.serverInfo.version
      expect(version, `${profile} serverInfo.version`).toBe(`0.2.0+${hash.slice(0, 16)}`)
      expect(tools).not.toContain(hash.slice(0, 16))
      versions.add(version)
    }
    expect(versions.size, 'one version per profile').toBe(3)
  })
})
