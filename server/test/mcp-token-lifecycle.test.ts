// Token lifecycle over real HTTP (#552): what a client sees on the request
// right after a token is revoked, expires or loses its owner, and how the
// token is stored. mcp-connections.test.ts covers resolveMcpToken itself.
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { mcpConnections, securityEvents } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

const REFUSED = { error: 'invalid, revoked or expired MCP token' }

let app: FastifyInstance
let baseUrl: string

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(async () => app.close())

/** One JSON-RPC request to /mcp: the HTTP status and the parsed body. */
async function mcp(token: string, method = 'tools/call', params: unknown = { name: 'list_vaults', arguments: {} }) {
  resetRateLimits()
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  // /mcp answers a JSON object: a JSON-RPC response, or {error} before the transport.
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body }
}

async function mint(cookie: string, body: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie },
    body: { name: 'lifecycle', scope: 'account', ...body },
  })
  const json: { id: string; token: string; error?: string } = res.json()
  return { status: res.statusCode, json }
}

describe('MCP token lifecycle over HTTP (#552)', () => {
  it('a revoked token is refused on the very next request', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const { json: conn } = await mint(cookie)

    const before = await mcp(conn.token)
    expect(before.status).toBe(200)
    expect(before.body.result).toBeTruthy()

    const revoke = await app.inject({ method: 'POST', url: `/api/mcp-connections/${conn.id}/revoke`, headers: { cookie } })
    expect(revoke.statusCode).toBe(200)

    // No grace period and no cache: the request straight after the revoke is refused.
    const after = await mcp(conn.token)
    expect(after.status).toBe(401)
    expect(after.body).toEqual(REFUSED)
    // Every MCP method, not only tool calls.
    expect((await mcp(conn.token, 'tools/list', {})).status).toBe(401)
  })

  it('an expired token is refused, and a token cannot be minted already expired', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)

    const past = await mint(cookie, { expiresAt: new Date(Date.now() - 60_000).toISOString() })
    expect(past.status).toBe(400)
    expect(past.json.error).toBe('expiresAt must be in the future')

    const { json: conn } = await mint(cookie, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    expect((await mcp(conn.token)).status).toBe(200)

    // Expiry is checked on every request against the stored expires_at (#640).
    await db
      .update(mcpConnections)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(mcpConnections.id, conn.id))
    const after = await mcp(conn.token)
    expect(after.status).toBe(401)
    expect(after.body).toEqual(REFUSED)
  })

  it("deactivating a user stops that user's tokens on the next request", async () => {
    const admin = await createActiveUser({ role: 'admin' })
    const adminCookie = await loginCookie(app, admin.email)
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const account = (await mint(cookie)).json
    const created = await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'lifecycle-pinned' } })
    const vault: { id: string } = created.json()
    const pinned = (await mint(cookie, { scope: 'vault', vaultId: vault.id })).json
    expect((await mcp(account.token)).status).toBe(200)
    expect((await mcp(pinned.token, 'tools/list', {})).status).toBe(200)

    const deactivate = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.id}/deactivate`,
      headers: { cookie: adminCookie },
    })
    expect(deactivate.statusCode).toBe(200)

    // Both the account token and the vault-pinned token stop at once.
    for (const token of [account.token, pinned.token]) {
      const after = await mcp(token)
      expect(after.status).toBe(401)
      expect(after.body).toEqual(REFUSED)
    }

    // Today's behaviour, documented: deactivation does not revoke the
    // connections, it makes them unresolvable while the user is inactive. A
    // reactivated user's unrevoked, unexpired tokens work again.
    const rows = await db.select().from(mcpConnections).where(eq(mcpConnections.userId, user.id))
    expect(rows.map((r) => r.revokedAt)).toEqual([null, null])
    const reactivate = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.id}/reactivate`,
      headers: { cookie: adminCookie },
    })
    expect(reactivate.statusCode).toBe(200)
    expect((await mcp(account.token)).status).toBe(200)
  })

  it('stores only a SHA-256 hash of the token, never the token itself', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const { json: conn } = await mint(cookie, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    expect(conn.token).toMatch(/^[0-9a-f]{64}$/)
    await mcp(conn.token)

    const [row] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, conn.id))
    expect(row!.tokenHash).not.toBe(conn.token)
    expect(row!.tokenHash).toBe(createHash('sha256').update(conn.token).digest('hex'))
    // No other column of the row, and no audit event about it, holds the raw token.
    expect(JSON.stringify(row)).not.toContain(conn.token)
    const events = await db.select().from(securityEvents).where(eq(securityEvents.mcpConnectionId, conn.id))
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain(conn.token)
    // The listing shows the connection without its token (or its hash).
    const listed = await app.inject({ method: 'GET', url: '/api/mcp-connections', headers: { cookie } })
    expect(listed.body).toContain(conn.id)
    expect(listed.body).not.toContain(conn.token)
    expect(listed.body).not.toContain(row!.tokenHash)
  })
})
