import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { checkRateLimit, resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

describe('mcp rate limiting', () => {
  beforeEach(() => {
    resetRateLimits()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('permits calls up to the ceiling and blocks call #121', () => {
    const connId = 'test-conn-1'
    for (let i = 1; i <= 120; i++) {
      expect(checkRateLimit(connId).ok).toBe(true)
    }
    // 121st call must be blocked
    expect(checkRateLimit(connId).ok).toBe(false)
  })

  it('maintains independent rate limits across distinct connections', () => {
    const connA = 'conn-a'
    const connB = 'conn-b'

    for (let i = 1; i <= 120; i++) {
      checkRateLimit(connA)
    }
    expect(checkRateLimit(connA).ok).toBe(false)

    // connB should still be unthrottled
    expect(checkRateLimit(connB).ok).toBe(true)
  })

  it('clears state upon resetRateLimits', () => {
    const conn = 'conn-reset'
    for (let i = 1; i <= 120; i++) {
      checkRateLimit(conn)
    }
    expect(checkRateLimit(conn).ok).toBe(false)

    resetRateLimits()
    expect(checkRateLimit(conn).ok).toBe(true)
  })

  it('a refusal says how long until the window ends; the window reopens exactly then (#440)', () => {
    const start = 1_800_000_000_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    const conn = 'conn-retry-after'
    for (let i = 1; i <= 120; i++) expect(checkRateLimit(conn)).toEqual({ ok: true })
    now.mockReturnValue(start + 12_345)
    expect(checkRateLimit(conn)).toEqual({ ok: false, retryAfterMs: 47_655 })
    now.mockReturnValue(start + 59_999)
    expect(checkRateLimit(conn)).toEqual({ ok: false, retryAfterMs: 1 })
    now.mockReturnValue(start + 60_000)
    expect(checkRateLimit(conn)).toEqual({ ok: true })
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

  async function mint(cookie: string): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie },
      body: { name: 'rate-limit', scope: 'account' },
    })
    return res.json<{ id: string; token: string }>()
  }

  function post(token: string, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) {
    return fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    })
  }

  /** Requests of the limit sent over HTTP; the rest are counted in the connection's bucket directly. */
  const HTTP_CALLS = 2

  /**
   * Uses up the connection's `LIMIT` requests and sends one more, returning
   * that response. The first `LIMIT - HTTP_CALLS` go straight into its bucket
   * (`checkRateLimit`, as the route calls it) and the last `HTTP_CALLS` over
   * HTTP, all of which must pass: request #121 is refused only if each HTTP
   * request counts exactly once. 120 HTTP requests per test cost seconds
   * under load without proving more (#862); the unit tests above pin the
   * 120 itself.
   */
  async function exhaust(connection: { id: string; token: string }, body?: unknown): Promise<Response> {
    for (let i = 0; i < LIMIT - HTTP_CALLS; i++) checkRateLimit(connection.id)
    const statuses: number[] = []
    for (let i = 0; i < HTTP_CALLS; i++) {
      const res = await post(connection.token)
      await res.arrayBuffer()
      statuses.push(res.status)
    }
    expect(statuses).toEqual(Array(HTTP_CALLS).fill(200))
    return post(connection.token, body)
  }

  it('refuses request #121 on one connection within a minute with HTTP 429', async () => {
    const user = await createActiveUser()
    const connection = await mint(await loginCookie(app, user.email))
    const limited = await exhaust(connection)
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
    const other = await post(second.token)
    expect(other.status).toBe(200)
    await other.arrayBuffer()
  })

  // #440: the 429 is a JSON-RPC error answering the request (its `id`), with
  // the #439 envelope as `error.data` and Retry-After in seconds.
  it('the 429 is a JSON-RPC error with the request id, the RATE_LIMITED envelope and Retry-After (#440)', async () => {
    const user = await createActiveUser()
    const connection = await mint(await loginCookie(app, user.email))
    const limited = await exhaust(connection, { jsonrpc: '2.0', id: 'req-121', method: 'tools/list', params: {} })
    expect(limited.status).toBe(429)
    const retryAfter = Number(limited.headers.get('retry-after'))
    expect(Number.isInteger(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    const body = (await limited.json()) as {
      jsonrpc: string
      id: unknown
      error: { code: number; message: string; data: { code: string; message: string; retryable: boolean; retryAfterMs: number } }
    }
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 'req-121',
      error: {
        code: -32000,
        message: 'rate limit exceeded for this connection',
        data: { code: 'RATE_LIMITED', message: 'rate limit exceeded for this connection', retryable: true },
      },
    })
    expect(Object.keys(body.error.data)).toEqual(['code', 'message', 'retryable', 'retryAfterMs'])
    // Retry-After is retryAfterMs rounded up to whole seconds.
    expect(retryAfter).toBe(Math.ceil(body.error.data.retryAfterMs / 1000))
  })

  it('a refused batch or notification has id null (#440)', async () => {
    const user = await createActiveUser()
    const connection = await mint(await loginCookie(app, user.email))
    const batch = await exhaust(connection, [{ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }])
    expect(batch.status).toBe(429)
    expect(((await batch.json()) as { id: unknown }).id).toBeNull()
    const notification = await post(connection.token, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(notification.status).toBe(429)
    expect(((await notification.json()) as { id: unknown }).id).toBeNull()
  })
})
