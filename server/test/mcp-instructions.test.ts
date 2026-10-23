// initialize.instructions (#435): the rules an agent needs before its first
// call, one fixed text per profile. A reader learns the budget, the
// `truncated` block and its cursor, and where the manuals are; writer and
// admin also learn how a whole body merges and how to retry a note write. The
// text names no id, date or pin, so every token of a profile gets the same
// bytes (#681), and it counts in the tools/list budget
// (mcp-tool-budget.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>

let app: FastifyInstance
let baseUrl: string
let cookie: string
const clients: Client[] = []

async function post(url: string, body: Args): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'POST', url, headers: { cookie }, body })
  if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${url}: ${res.statusCode} ${res.body}`)
  return res.json<Record<string, unknown>>()
}

/** A fresh MCP session (its own initialize) for a new token minted with `body`, or for `token`. */
async function session(body: Args | string): Promise<Client> {
  const token = typeof body === 'string' ? body : String((await post('/api/mcp-connections', body)).token)
  const client = new Client({ name: 'instructions-test', version: '0.0.0' })
  resetRateLimits()
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
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

describe('initialize.instructions (#435)', () => {
  it('gives a reader the budget, truncated/cursor and manual rules, without the write rules', async () => {
    const reader = await session({ name: 'instr-reader', scope: 'account', access: 'admin', profile: 'reader' })
    const text = reader.getInstructions() ?? ''
    for (const rule of ['budget_tokens', 'truncated', 'cursor', 'read_note', 'read_file', 'elara://manual/']) expect(text).toContain(rule)
    expect(text).not.toContain('idempotency_key')
    expect(text).not.toContain('base_rev')
    // `truncated` is promised only for tools with `budget_tokens`: search, list_vaults and list_repositories have none.
    expect(text).toContain('Tools with `budget_tokens`')
    const { tools } = await reader.listTools()
    const unbudgeted = tools.filter((t) => !('budget_tokens' in (t.inputSchema.properties ?? {}))).map((t) => t.name)
    expect(unbudgeted).toEqual(expect.arrayContaining(['search', 'list_vaults', 'list_repositories']))
  })

  it('adds the merge and retry rules for writer and admin, scoped to what they are true of', async () => {
    const writerClient = await session({ name: 'instr-writer', scope: 'account', access: 'admin', profile: 'writer' })
    const adminClient = await session({ name: 'instr-admin', scope: 'account', access: 'admin', profile: 'admin' })
    const writer = writerClient.getInstructions() ?? ''
    const admin = adminClient.getInstructions() ?? ''
    for (const text of [writer, admin]) {
      for (const rule of ['budget_tokens', 'truncated', 'cursor', 'elara://manual/', 'base_rev', 'idempotency_key']) expect(text).toContain(rule)
      // A paged read_note records no last read, so a whole body would replace the live text: the rule says so.
      expect(text).toContain('last unpaged read_note; after a paged read send its `rev` as `base_rev`')
      // Only the note writes take idempotency_key; admin's other writes refuse it as an unknown argument.
      expect(text).toContain('Retry a note write with the same `idempotency_key`')
    }
    resetRateLimits()
    const keyed = (await adminClient.listTools()).tools
      .filter((t) => 'idempotency_key' in (t.inputSchema.properties ?? {}))
      .map((t) => t.name)
    expect(keyed.length).toBeGreaterThan(0)
    expect(keyed.filter((name) => !name.includes('note'))).toEqual([])
    // Scoped to note writes, the one text is true for both profiles.
    expect(admin).toBe(writer)
  })

  it('names only manuals the token can read', async () => {
    for (const profile of ['reader', 'writer'] as const) {
      const client = await session({ name: `instr-manuals-${profile}`, scope: 'account', access: 'admin', profile })
      const named = (client.getInstructions() ?? '').match(/elara:\/\/manual\/[a-z]+/g) ?? []
      expect(named.length, profile).toBeGreaterThan(0)
      resetRateLimits()
      const listed = new Set((await client.listResources()).resources.map((r) => r.uri))
      expect(named.filter((uri) => !listed.has(uri)), profile).toEqual([])
    }
  })

  it('answers the same bytes on every initialize and for every pin of one profile', async () => {
    const token = String((await post('/api/mcp-connections', { name: 'instr-stable', scope: 'account', access: 'admin', profile: 'reader' })).token)
    const first = (await session(token)).getInstructions()
    expect(first).toBeTruthy()
    expect((await session(token)).getInstructions()).toBe(first)

    const vaults = [String((await post('/api/vaults', { name: 'instr-a' })).id), String((await post('/api/vaults', { name: 'instr-b' })).id)]
    for (const profile of ['reader', 'writer'] as const) {
      const [a, b] = await Promise.all(vaults.map((vaultId, i) => session({ name: `instr-pin-${profile}-${i}`, scope: 'vault', vaultId, profile })))
      const text = a!.getInstructions()
      expect(text, profile).toBeTruthy()
      expect(b!.getInstructions(), profile).toBe(text)
      for (const vaultId of vaults) expect(text, profile).not.toContain(vaultId)
      expect(text, profile).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-|\b\d{4}-\d{2}-\d{2}\b/)
    }
  })
})
