import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { instanceState, users } from '../src/db/schema.js'
import { ensureInstanceState } from '../src/auth/bootstrap.js'
import { sentMails } from '../src/email/mailer.js'
import { resetLockouts } from '../src/auth/lockout.js'
import { createActiveUser, loginCookie, TEST_PASSWORD, uniqueEmail } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('bootstrap & setup', () => {
  it('claims the initial admin with the setup token, exactly once', async () => {
    await db.delete(instanceState)
    const { setupPending, setupToken } = await ensureInstanceState()
    expect(setupPending).toBe(true)
    expect(setupToken).toBeTruthy()

    const bad = await app.inject({
      method: 'POST',
      url: '/api/setup',
      body: { token: 'wrong', email: uniqueEmail('admin'), password: TEST_PASSWORD },
    })
    expect(bad.statusCode).toBe(403)

    const email = uniqueEmail('admin')
    const ok = await app.inject({
      method: 'POST',
      url: '/api/setup',
      body: { token: setupToken, email, password: TEST_PASSWORD },
    })
    expect(ok.statusCode).toBe(200)

    const admin = (await db.select().from(users).where(eq(users.email, email)))[0]
    expect(admin?.role).toBe('admin')
    expect(admin?.status).toBe('active')

    // Second claim is impossible.
    const again = await app.inject({
      method: 'POST',
      url: '/api/setup',
      body: { token: setupToken, email: uniqueEmail(), password: TEST_PASSWORD },
    })
    expect(again.statusCode).toBe(404)
  })
})

describe('signup → verify → approve → login', () => {
  it('walks the full lifecycle and blocks login at each early stage', async () => {
    const email = uniqueEmail('signup')
    const signup = await app.inject({
      method: 'POST',
      url: '/api/signup',
      body: { email, password: TEST_PASSWORD },
    })
    expect(signup.statusCode).toBe(200)

    // Not verified, not approved → no login.
    let login = await app.inject({
      method: 'POST',
      url: '/api/login',
      body: { email, password: TEST_PASSWORD },
    })
    expect(login.statusCode).toBe(401)

    const mail = sentMails.find((m) => m.to === email)
    expect(mail).toBeTruthy()
    const code = mail!.text.match(/(\d{6})/)![1]!
    const verify = await app.inject({
      method: 'POST',
      url: '/api/verify-email',
      body: { email, code },
    })
    expect(verify.statusCode).toBe(200)

    // Verified but still pending approval → no login.
    login = await app.inject({
      method: 'POST',
      url: '/api/login',
      body: { email, password: TEST_PASSWORD },
    })
    expect(login.statusCode).toBe(401)

    const admin = await createActiveUser({ role: 'admin' })
    const adminCookie = await loginCookie(app, admin.email)
    const pendingUser = (await db.select().from(users).where(eq(users.email, email)))[0]!
    const approve = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${pendingUser.id}/approve`,
      headers: { cookie: adminCookie },
    })
    expect(approve.statusCode).toBe(200)

    login = await app.inject({
      method: 'POST',
      url: '/api/login',
      body: { email, password: TEST_PASSWORD },
    })
    expect(login.statusCode).toBe(200)
  })

  it('rejects admin routes for non-admins', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('sessions', () => {
  it('logout invalidates the session', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
    ).toBe(200)
    await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
    ).toBe(401)
  })

  it('deactivation kills live sessions immediately', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const admin = await createActiveUser({ role: 'admin' })
    const adminCookie = await loginCookie(app, admin.email)
    await app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.id}/deactivate`,
      headers: { cookie: adminCookie },
    })
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
    ).toBe(401)
  })
})

describe('password reset', () => {
  it('resets the password with a single-use token and kills sessions', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    await app.inject({
      method: 'POST',
      url: '/api/request-password-reset',
      body: { email: user.email },
    })
    const mail = [...sentMails].reverse().find((m) => m.to === user.email)!
    const token = mail.text.match(/token: (\w+)/)![1]!

    const reset = await app.inject({
      method: 'POST',
      url: '/api/reset-password',
      body: { token, password: 'brand-new-password-1' },
    })
    expect(reset.statusCode).toBe(200)

    // Old session dead, old password dead, new password works.
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          body: { email: user.email, password: TEST_PASSWORD },
        })
      ).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          body: { email: user.email, password: 'brand-new-password-1' },
        })
      ).statusCode,
    ).toBe(200)

    // Token is single-use.
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/reset-password',
      body: { token, password: 'another-password-2' },
    })
    expect(reuse.statusCode).toBe(400)
  })
})

describe('brute-force lockout', () => {
  it('locks an account after repeated failures', async () => {
    resetLockouts()
    const user = await createActiveUser()
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/login',
        body: { email: user.email, password: 'wrong-password' },
      })
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/api/login',
      body: { email: user.email, password: TEST_PASSWORD },
    })
    expect(locked.statusCode).toBe(429)
    resetLockouts()
  })
})
