import { afterAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'

// #911: behind a reverse proxy every request reaches the app from the proxy's
// address. Unless the app is told which peers are proxies (ELARA_TRUST_PROXY,
// Fastify's trustProxy), `req.ip` is that address for every user: one
// rate-limit bucket, one login lockout and one address in the security
// events for everyone. X-Forwarded-For may be read only from those peers:
// from anyone else it is whatever the client chose to write.

/** The reverse proxy, as the app sees it. */
const PROXY = '10.0.0.7'
/** A peer that is not the proxy: a client reaching the app's port directly. */
const STRANGER = '198.51.100.7'

const apps: FastifyInstance[] = []

afterAll(async () => {
  for (const app of apps) await app.close()
})

/** A fresh app (its own rate-limit counters) with this trust setting; unset = the default (off). */
async function appWith(trustProxy?: false | string[]): Promise<FastifyInstance> {
  const app = await buildApp(trustProxy === undefined ? {} : { trustProxy })
  await app.ready()
  apps.push(app)
  return app
}

/** What the instance-wide rate limit has left for the client of this request (its bucket, keyed by `req.ip`). */
async function remaining(app: FastifyInstance, remoteAddress: string, forwardedFor?: string): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: '/health',
    remoteAddress,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  })
  return Number(res.headers['x-ratelimit-remaining'])
}

/** The address a failed login records in the security events (`req.ip`). */
async function recordedIp(app: FastifyInstance, remoteAddress: string, forwardedFor?: string): Promise<string | null> {
  const email = `trust-proxy-${Math.random().toString(36).slice(2)}@example.test`
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    remoteAddress,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    body: { email, password: 'not-the-password-911' },
  })
  expect(res.statusCode).toBe(401)
  const rows = (await db.execute(
    sql`SELECT ip FROM security_events WHERE type = 'login_failed' AND detail->>'email' = ${email}`,
  )) as unknown as Array<{ ip: string | null }>
  expect(rows).toHaveLength(1)
  return rows[0]!.ip
}

describe('trusted proxy (ELARA_TRUST_PROXY names it)', () => {
  it('gives each client behind the proxy its own rate-limit bucket', async () => {
    const app = await appWith([PROXY])
    const first = await remaining(app, PROXY, '203.0.113.1')
    // Another client through the same proxy: a bucket of its own, not the first one's minus one.
    expect(await remaining(app, PROXY, '203.0.113.2')).toBe(first)
    expect(await remaining(app, PROXY, '203.0.113.1')).toBe(first - 1)
  })

  it('records the client, not the proxy, in the security events', async () => {
    const app = await appWith([PROXY])
    expect(await recordedIp(app, PROXY, '203.0.113.9')).toBe('203.0.113.9')
  })

  it('reads the address the proxy appended, not what the client wrote in front of it', async () => {
    const app = await appWith([PROXY])
    // The client sent "X-Forwarded-For: 192.0.2.66"; the proxy appended the address it saw.
    expect(await recordedIp(app, PROXY, '192.0.2.66, 203.0.113.5')).toBe('203.0.113.5')
  })

  it('takes a CIDR for the proxies', async () => {
    const app = await appWith(['10.0.0.0/8'])
    expect(await recordedIp(app, PROXY, '203.0.113.10')).toBe('203.0.113.10')
  })
})

describe('a forged X-Forwarded-For from a peer that is not the proxy', () => {
  it('is ignored: the peer is the client and keeps one bucket whatever it writes', async () => {
    const app = await appWith([PROXY])
    const first = await remaining(app, STRANGER, '203.0.113.1')
    expect(await remaining(app, STRANGER, '203.0.113.2')).toBe(first - 1)
    expect(await recordedIp(app, STRANGER, '203.0.113.3')).toBe(STRANGER)
  })
})

describe('no trusted proxy (the default)', () => {
  it('ignores X-Forwarded-For: the socket peer is the client', async () => {
    const app = await appWith()
    const first = await remaining(app, STRANGER, '203.0.113.1')
    expect(await remaining(app, STRANGER, '203.0.113.2')).toBe(first - 1)
    expect(await recordedIp(app, PROXY, '203.0.113.4')).toBe(PROXY)
  })
})
