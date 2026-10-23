// What a token pays before its first call (#429, ADR-004 §2.6): the
// `tools/list` result plus the `initialize` instructions, counted as
// characters / 4 like the benchmark counts tokens. A reader token stays
// within 2,000 tokens and a writer token within 4,000; the admin size is
// reported (its ceiling is in mcp-tool-schema.test.ts). Every tool
// description is at most two sentences: the long manuals are MCP resources
// (mcp-manuals.test.ts). The bytes do not depend on the call or the pin, so
// a client can cache them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
type Profile = 'reader' | 'writer' | 'admin'

/** Tokens (characters / 4) of `tools/list` + `initialize.instructions` a profile may cost. */
const BUDGET_TOKENS: Partial<Record<Profile, number>> = { reader: 2_000, writer: 4_000 }

let app: FastifyInstance
let baseUrl: string
let cookie: string
const clients: Client[] = []

function field(body: unknown, key: string): string {
  if (body && typeof body === 'object' && key in body) {
    const value: unknown = Reflect.get(body, key)
    if (typeof value === 'string') return value
  }
  throw new Error(`response has no ${key}: ${JSON.stringify(body)}`)
}

async function post(url: string, body: Args): Promise<unknown> {
  const res = await app.inject({ method: 'POST', url, headers: { cookie }, body })
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`)
  return res.json()
}

async function connect(body: Args): Promise<Client> {
  const token = field(await post('/api/mcp-connections', body), 'token')
  const client = new Client({ name: 'tool-budget-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

/** The exact bytes of a `tools/list` result. */
async function toolsList(client: Client): Promise<string> {
  resetRateLimits()
  return JSON.stringify(await client.listTools())
}

/**
 * Sentences in a description: code spans and abbreviations are not sentence
 * ends; a sentence ends at `.`, `!` or `?` followed by a space or the end.
 */
function sentences(text: string): number {
  const prose = text.replace(/`[^`]*`/g, 'code').replace(/\b(e\.g|i\.e|etc|vs)\./g, '$1')
  return (prose.match(/[.!?](?=\s|$)/g) ?? []).length
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('tools/list budget per profile (#429)', () => {
  it('keeps each profile within its budget (characters / 4)', async () => {
    const sizes = {} as Record<Profile, number>
    for (const profile of ['reader', 'writer', 'admin'] as const) {
      // What a token pays before its first call: `tools/list` plus the instructions.
      const client = await connect({ name: `budget-${profile}`, scope: 'account', access: 'admin', profile })
      sizes[profile] = (await toolsList(client)).length + (client.getInstructions() ?? '').length
    }
    console.log(
      (Object.entries(sizes) as Array<[Profile, number]>)
        .map(([profile, chars]) => `tools/list + instructions, ${profile} account token: ${chars} chars, ~${Math.ceil(chars / 4)} tokens`)
        .join('\n'),
    )
    for (const [profile, budget] of Object.entries(BUDGET_TOKENS)) {
      expect(Math.ceil(sizes[profile as Profile] / 4), `${profile} tokens`).toBeLessThanOrEqual(budget)
    }
  })

  it('answers the same bytes on every call, and for every pin of one profile and scope', async () => {
    const reader = await connect({ name: 'budget-stable', scope: 'account', access: 'admin', profile: 'reader' })
    expect(await toolsList(reader)).toBe(await toolsList(reader))
    const vaults = [field(await post('/api/vaults', { name: 'budget-a' }), 'id'), field(await post('/api/vaults', { name: 'budget-b' }), 'id')]
    const [a, b] = await Promise.all(vaults.map((vaultId, i) => connect({ name: `budget-pin-${i}`, scope: 'vault', vaultId, profile: 'reader' })))
    expect(await toolsList(a!)).toBe(await toolsList(b!))
  })

  it('describes every tool in at most two sentences', async () => {
    const admin = await connect({ name: 'budget-descriptions', scope: 'account', access: 'admin', profile: 'admin' })
    resetRateLimits()
    const { tools } = await admin.listTools()
    expect(tools.length).toBeGreaterThan(50)
    const long = tools
      .map((t) => ({ name: t.name, n: sentences(t.description ?? '') }))
      .filter(({ n }) => n < 1 || n > 2)
      .map(({ name, n }) => `${name}: ${n} sentences`)
    expect(long).toEqual([])
  })
})
