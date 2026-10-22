// #858: the admin security-event log lists events in the order they were
// recorded, whatever the database clock did. `created_at` comes from the
// clock, which steps back (the test database's by up to 3.5 s) and gives every
// row of one insert the same instant.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { logSecurityEvent } from '../src/auth/security-events.js'
import { db } from '../src/db/client.js'
import { securityEvents } from '../src/db/schema.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let adminCookie: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  adminCookie = await loginCookie(app, (await createActiveUser({ role: 'admin' })).email)
})

afterAll(async () => app.close())

async function page(query: string): Promise<Array<{ id: string; detail: unknown }>> {
  const res = await app.inject({ method: 'GET', url: `/api/admin/security-events?${query}`, headers: { cookie: adminCookie } })
  expect(res.statusCode).toBe(200)
  return res.json() as Array<{ id: string; detail: unknown }>
}

describe('security-event order does not follow the database clock (#858)', () => {
  it('lists the event recorded last first, and offset pages split tied events exactly once', async () => {
    const marker = randomUUID()
    // Recorded in one insert before the clock stepped back: one instant, 5 s after the next event's.
    await db.insert(securityEvents).values(
      ['first', 'second', 'third'].map((step) => ({
        type: 'test_clock_step',
        detail: { marker, step },
        createdAt: sql`now() + interval '5 seconds'`,
      })),
    )
    await logSecurityEvent({ type: 'test_clock_step', detail: { marker, step: 'last' } })

    const first = await page('limit=50&offset=0')
    expect(first.slice(0, 4).map((e) => e.detail)).toEqual(
      ['last', 'third', 'second', 'first'].map((step) => ({ marker, step })),
    )
    const single = await Promise.all([0, 1, 2, 3].map((offset) => page(`limit=1&offset=${offset}`)))
    expect(single.flat().map((e) => e.id)).toEqual(first.slice(0, 4).map((e) => e.id))
  })
})
