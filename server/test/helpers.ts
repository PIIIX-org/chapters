import type { FastifyInstance } from 'fastify'
import { db } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { hashPassword } from '../src/auth/passwords.js'

let counter = 0
export function uniqueEmail(prefix = 'user'): string {
  counter += 1
  return `${prefix}-${Date.now()}-${counter}@test.local`
}

export const TEST_PASSWORD = 'correct-horse-battery'

/** Inserts an active, verified user directly (skips signup/approval flow). */
export async function createActiveUser(
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<typeof users.$inferSelect> {
  const [user] = await db
    .insert(users)
    .values({
      email: uniqueEmail(),
      passwordHash: await hashPassword(TEST_PASSWORD),
      status: 'active',
      emailVerifiedAt: new Date(),
      ...overrides,
    })
    .returning()
  return user!
}

/** Logs in and returns the raw session token (for collab connections). */
export async function loginToken(
  app: FastifyInstance,
  email: string,
  password = TEST_PASSWORD,
): Promise<string> {
  const cookie = await loginCookie(app, email, password)
  return cookie.split('=')[1]!
}

/** Logs in via the real endpoint and returns the session cookie header. */
export async function loginCookie(
  app: FastifyInstance,
  email: string,
  password = TEST_PASSWORD,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    body: { email, password },
  })
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${res.body}`)
  }
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!raw) throw new Error('no session cookie returned')
  return raw.split(';')[0]!
}
