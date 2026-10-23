// Tool annotations (#434, ADR-004 §2.6): every tool in tools/list says
// whether it only reads, may destroy data, and whether a repeat of the same
// call has no further effect. They are derived from the tool record, so a
// read tool lists exactly `{readOnlyHint: true}`, and every other tool lists
// `destructiveHint` explicitly, because MCP's default for it is `true`.
// The destructive and idempotent sets are the documented lists below.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { buildApp } from '../src/app.js'
import { listMcpTools } from '../src/mcp/server.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

/** Tools that delete, purge, revoke or remove, plus the preference write that replaces whole maps. */
const DESTRUCTIVE = [
  'delete_graph_perspective',
  'delete_note',
  'delete_repository',
  'delete_team',
  'delete_vault',
  'purge_note',
  'purge_revision',
  'purge_vault',
  'remove_team_member',
  'revoke_repository_share',
  'revoke_vault_share',
  'update_vault_preferences',
]

/** Writes whose repeat, without an idempotency_key, changes nothing more or fails. */
const IDEMPOTENT = [
  'delete_graph_perspective',
  'delete_repository',
  'delete_team',
  'delete_vault',
  'mark_notification_read',
  'purge_note',
  'purge_revision',
  'purge_vault',
  'remove_team_member',
  'restore_vault',
  'revoke_repository_share',
  'revoke_vault_share',
  'set_repository_graph_preference',
  'set_vault_graph_preference',
  'share_repository',
  'update_repository',
  'update_vault',
  'update_vault_preferences',
]

let app: FastifyInstance
let baseUrl: string
let cookie: string
const clients: Client[] = []

async function listed(profile: 'reader' | 'admin'): Promise<Tool[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie },
    body: { name: `annotations-${profile}`, scope: 'account', access: 'admin', profile },
  })
  const { token } = res.json<{ token: string }>()
  const client = new Client({ name: 'tool-annotations-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  resetRateLimits()
  return (await client.listTools()).tools
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

describe('tool annotations (#434)', () => {
  it('derives every tool’s annotations from its capability', async () => {
    const tools = await listed('admin')
    const capability = new Map(listMcpTools().map((t) => [t.name, t.capability]))
    expect(tools.map((t) => t.name).sort()).toEqual([...capability.keys()].sort())
    const wrong = tools.flatMap((t) => {
      const want =
        capability.get(t.name) === 'read'
          ? { readOnlyHint: true }
          : {
              destructiveHint: DESTRUCTIVE.includes(t.name),
              ...(IDEMPOTENT.includes(t.name) ? { idempotentHint: true } : {}),
            }
      return JSON.stringify(t.annotations) === JSON.stringify(want) ? [] : [`${t.name}: ${JSON.stringify(t.annotations)}`]
    })
    expect(wrong).toEqual([])
  })

  it('marks exactly the documented tools destructive and idempotent', async () => {
    const tools = await listed('admin')
    const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true)
    expect(writes.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name).sort()).toEqual(DESTRUCTIVE)
    expect(writes.filter((t) => t.annotations?.idempotentHint === true).map((t) => t.name).sort()).toEqual(IDEMPOTENT)
    // Every tool named for deleting, purging, revoking or removing is in the destructive set.
    const byName = tools.filter((t) => /^(delete|purge|revoke|remove)_/.test(t.name)).map((t) => t.name)
    expect(byName.length).toBeGreaterThan(0)
    expect(DESTRUCTIVE).toEqual(expect.arrayContaining(byName))
    // No title: it is optional and costs tokens in every tools/list (decision in fixes/434-tool-annotations).
    expect(tools.filter((t) => t.title !== undefined || t.annotations?.title !== undefined)).toEqual([])
  })

  it('lists only read-only tools for a reader token', async () => {
    const tools = await listed('reader')
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)).toEqual([])
  })

  it('keeps the same annotations on the shared tool record', async () => {
    const tools = await listed('admin')
    const record = new Map(listMcpTools().map((t) => [t.name, t]))
    // Both sides must be present: two missing annotations would stringify equal.
    expect(tools.filter((t) => t.annotations === undefined || record.get(t.name)?.annotations === undefined).map((t) => t.name)).toEqual([])
    const differ = tools.filter((t) => JSON.stringify(record.get(t.name)?.annotations) !== JSON.stringify(t.annotations)).map((t) => t.name)
    expect(differ).toEqual([])
  })
})
