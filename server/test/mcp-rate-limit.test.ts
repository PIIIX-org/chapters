import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { checkRateLimit, resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

describe('mcp rate limiting', () => {
  beforeEach(() => {
    resetRateLimits()
  })

  it('permits calls up to the ceiling and blocks call #121', () => {
    const connId = 'test-conn-1'
    for (let i = 1; i <= 120; i++) {
      expect(checkRateLimit(connId)).toBe(true)
    }
    // 121st call must be blocked
    expect(checkRateLimit(connId)).toBe(false)
  })

  it('maintains independent rate limits across distinct connections', () => {
    const connA = 'conn-a'
    const connB = 'conn-b'

    for (let i = 1; i <= 120; i++) {
      checkRateLimit(connA)
    }
    expect(checkRateLimit(connA)).toBe(false)

    // connB should still be unthrottled
    expect(checkRateLimit(connB)).toBe(true)
  })

  it('clears state upon resetRateLimits', () => {
    const conn = 'conn-reset'
    for (let i = 1; i <= 120; i++) {
      checkRateLimit(conn)
    }
    expect(checkRateLimit(conn)).toBe(false)

    resetRateLimits()
    expect(checkRateLimit(conn)).toBe(true)
  })
})

// The limit as an MCP client meets it on POST /mcp (#552). The test
// environment leaves MCP_RATE_LIMIT unset: the documented default, 120 per
// connection per minute.
describe('mcp rate limiting over HTTP (#552)', () => {
  const LIMIT = 120
  let app: FastifyInstance
  let baseUrl: string

  beforeAll(async () => {
    app = await buildApp()
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterAll(async () => app.close())

  async function mint(cookie: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie },
      body: { name: 'rate-limit', scope: 'account' },
    })
    const created: { token: string } = res.json()
    return created.token
  }

  function post(token: string) {
    return fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
  }

  /** Sends `LIMIT` requests on the token (all must pass), then one more, and returns that response. */
  async function exhaust(token: string): Promise<Response> {
    const statuses: number[] = []
    for (let i = 0; i < LIMIT; i++) {
      const res = await post(token)
      await res.arrayBuffer()
      statuses.push(res.status)
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([])
    return post(token)
  }

  it('refuses request #121 on one connection within a minute with HTTP 429', async () => {
    const user = await createActiveUser()
    const token = await mint(await loginCookie(app, user.email))
    const limited = await exhaust(token)
    expect(limited.status).toBe(429)
    await limited.arrayBuffer()
  })

  it('counts per connection, not per user: other tokens of the same user are not limited', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const first = await mint(cookie)
    const second = await mint(cookie)
    const limited = await exhaust(first)
    expect(limited.status).toBe(429)
    await limited.arrayBuffer()

    // Same user, second connection: its own bucket. A user with N tokens
    // can therefore make N x the limit per minute.
    const other = await post(second)
    expect(other.status).toBe(200)
    await other.arrayBuffer()
  })

  // Known defect #440 (fix list item 38): the 429 should carry Retry-After
  // and a JSON-RPC error body. This pins today's response; the fix for #440
  // changes these expectations.
  it('today: the 429 has no Retry-After header and a plain JSON body, not a JSON-RPC error (#440)', async () => {
    const user = await createActiveUser()
    const token = await mint(await loginCookie(app, user.email))
    const limited = await exhaust(token)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeNull()
    const body = (await limited.json()) as Record<string, unknown>
    expect(body).toEqual({ error: 'rate limit exceeded for this connection' })
    expect(body).not.toHaveProperty('jsonrpc')
  })
})
