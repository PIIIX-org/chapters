import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { ensureInstanceState } from '../src/auth/bootstrap.js'
import { setInstanceMfaRequirement } from '../src/auth/mfa.js'
import { sentMails } from '../src/email/mailer.js'
import { notify } from '../src/notifications/notify.js'
import { notifications } from '../src/db/schema.js'
import { createActiveUser, loginCookie, uniqueEmail, TEST_PASSWORD } from './helpers.js'

let app: FastifyInstance

async function login(email: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/login', body: { email, password } })
}

async function createVault(cookie: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/vaults',
    headers: { cookie },
    body: { name },
  })
  return (res.json() as { id: string }).id
}

beforeAll(async () => {
  // setInstanceMfaRequirement updates the singleton row; without a boot it
  // would update nothing and every MFA assertion would pass vacuously.
  await ensureInstanceState()
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await setInstanceMfaRequirement(false)
  await app.close()
})

describe('GET /me', () => {
  it('carries mfaEnabledAt and an mfaRequired that tracks the instance', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)

    await setInstanceMfaRequirement(false)
    const off = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(off.statusCode).toBe(200)
    expect(off.json()).toMatchObject({
      id: user.id,
      email: user.email,
      mfaEnabledAt: null,
      mfaRequired: false,
    })

    try {
      await setInstanceMfaRequirement(true)
      const on = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
      expect((on.json() as { mfaRequired: boolean }).mfaRequired).toBe(true)
    } finally {
      await setInstanceMfaRequirement(false)
    }

    // Not hardcoded null either: a user with TOTP on reports the timestamp.
    const enabledAt = new Date('2026-01-02T03:04:05.000Z')
    await db.update(users).set({ mfaEnabledAt: enabledAt }).where(eq(users.id, user.id))
    const enabled = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect((enabled.json() as { mfaEnabledAt: string }).mfaEnabledAt).toBe(
      enabledAt.toISOString(),
    )
  })
})

describe('POST /me/password', () => {
  it('rejects a wrong current password and leaves the old one working', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie },
      body: { currentPassword: 'not-the-password', newPassword: 'a-brand-new-password' },
    })
    expect(res.statusCode).toBe(400)

    expect((await login(user.email, 'a-brand-new-password')).statusCode).toBe(401)
    expect((await login(user.email, TEST_PASSWORD)).statusCode).toBe(200)
  })

  it('signs out every other session but not the caller', async () => {
    const user = await createActiveUser()
    const here = await loginCookie(app, user.email)
    const elsewhere = await loginCookie(app, user.email)
    expect(here).not.toBe(elsewhere)

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie: here },
      body: { currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'password_changed' })

    const mine = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: here } })
    expect(mine.statusCode).toBe(200)
    const other = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: elsewhere },
    })
    expect(other.statusCode).toBe(401)

    expect((await login(user.email, 'a-brand-new-password')).statusCode).toBe(200)
  })

  it('enforces the same minimum length as signup', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie },
      body: { currentPassword: TEST_PASSWORD, newPassword: 'short' },
    })
    expect(res.statusCode).toBe(400)
    expect((await login(user.email, TEST_PASSWORD)).statusCode).toBe(200)
  })
})

describe('POST /me/email', () => {
  it('clears verification, so the account can no longer log in', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const next = uniqueEmail('moved')

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/email',
      headers: { cookie },
      body: { email: next.toUpperCase(), password: TEST_PASSWORD },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'verification_sent' })

    const row = (await db.select().from(users).where(eq(users.id, user.id)))[0]!
    // Lowercased, or login's own lowercasing would never find it again.
    expect(row.email).toBe(next.toLowerCase())
    expect(row.emailVerifiedAt).toBeNull()

    expect((await login(next, TEST_PASSWORD)).statusCode).toBe(401)
    expect((await login(user.email, TEST_PASSWORD)).statusCode).toBe(401)
  })

  it('rejects a wrong password without touching the address', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/email',
      headers: { cookie },
      body: { email: uniqueEmail('nope'), password: 'not-the-password' },
    })
    expect(res.statusCode).toBe(400)
    const row = (await db.select().from(users).where(eq(users.id, user.id)))[0]!
    expect(row.email).toBe(user.email)
    expect(row.emailVerifiedAt).not.toBeNull()
  })

  it('409s on an address another account holds, leaving the old one intact', async () => {
    const user = await createActiveUser()
    const rival = await createActiveUser()
    const cookie = await loginCookie(app, user.email)

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/email',
      headers: { cookie },
      body: { email: rival.email, password: TEST_PASSWORD },
    })
    expect(res.statusCode).toBe(409)

    const row = (await db.select().from(users).where(eq(users.id, user.id)))[0]!
    expect(row.email).toBe(user.email)
    expect(row.emailVerifiedAt).not.toBeNull()
    expect((await login(user.email, TEST_PASSWORD)).statusCode).toBe(200)
  })
})

describe('/me/preferences', () => {
  it('round-trips the email opt-out', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)

    const initial = await app.inject({
      method: 'GET',
      url: '/api/me/preferences',
      headers: { cookie },
    })
    expect(initial.json()).toEqual({ emailNotifications: true })

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/me/preferences',
      headers: { cookie },
      body: { emailNotifications: false },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({ emailNotifications: false })

    const reread = await app.inject({
      method: 'GET',
      url: '/api/me/preferences',
      headers: { cookie },
    })
    expect(reread.json()).toEqual({ emailNotifications: false })
  })
})

describe('GET /me/export', () => {
  it('contains the vaults you own and not the ones shared with you', async () => {
    const owner = await createActiveUser()
    const sharer = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const sharerCookie = await loginCookie(app, sharer.email)

    const ownedId = await createVault(ownerCookie, 'Mine')
    const sharedId = await createVault(sharerCookie, 'Theirs')
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${sharedId}/shares`,
      headers: { cookie: sharerCookie },
      body: { granteeType: 'user', granteeId: owner.id, permission: 'edit' },
    })
    for (const [vaultId, cookie, name] of [
      [ownedId, ownerCookie, 'ada'],
      [sharedId, sharerCookie, 'grace'],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/notes`,
        headers: { cookie },
        body: { type: 'people', name, body: 'A note.' },
      })
    }
    // Guard the fixture: the shared vault really is readable by the caller,
    // so its absence from the zip is a decision and not a permission accident.
    const readable = await app.inject({
      method: 'GET',
      url: `/api/vaults/${sharedId}/tree`,
      headers: { cookie: ownerCookie },
    })
    expect(readable.statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET',
      url: '/api/me/export',
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toContain('chapters-account-export.zip')

    const names = new AdmZip(res.rawPayload).getEntries().map((e) => e.entryName)
    expect(names).toContain(`vaults/${ownedId}/people/ada.md`)
    expect(names).toContain(`vaults/${ownedId}/manifest.json`)
    expect(names.some((n) => n.startsWith(`vaults/${sharedId}/`))).toBe(false)
  })
})
describe('holes the unit-4 review found', () => {
  it('a superseded verification code cannot verify a later address', async () => {
    // The attack this closes: tokens are bound to a USER, not to the address
    // they were mailed to. Change to an address you control, keep that code,
    // then change to someone else's — without superseding, the first code
    // verifies the second address and you hold a verified account under an
    // address that never received mail.
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)

    const mine = uniqueEmail('mine')
    await app.inject({
      method: 'POST',
      url: '/api/me/email',
      headers: { cookie },
      body: { email: mine, password: TEST_PASSWORD },
    })
    const firstCode = /code is (\S+)/.exec(
      [...sentMails].reverse().find((m) => m.to === mine)!.text,
    )![1]!

    const someoneElse = uniqueEmail('victim')
    await app.inject({
      method: 'POST',
      url: '/api/me/email',
      headers: { cookie },
      body: { email: someoneElse, password: TEST_PASSWORD },
    })

    const stolen = await app.inject({
      method: 'POST',
      url: '/api/verify-email',
      body: { email: someoneElse, code: firstCode },
    })
    expect(stolen.statusCode).toBe(400)

    const [row] = await db.select().from(users).where(eq(users.id, user.id))
    expect(row!.emailVerifiedAt).toBeNull()
  })

  it('the code actually mailed for the new address still verifies it', async () => {
    // The other side of the same coin: superseding must not break the real
    // path. Without this, deleting the whole mail block from /me/email would
    // leave the suite green while locking out everyone who changes an address.
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const next = uniqueEmail('next')

    await app.inject({
      method: 'POST',
      url: '/api/me/email',
      headers: { cookie },
      body: { email: next, password: TEST_PASSWORD },
    })
    const mail = [...sentMails].reverse().find((m) => m.to === next)
    expect(mail, 'no verification mail was sent to the new address').toBeDefined()
    const code = /code is (\S+)/.exec(mail!.text)![1]!

    const verified = await app.inject({
      method: 'POST',
      url: '/api/verify-email',
      body: { email: next, code },
    })
    expect(verified.statusCode).toBe(200)
    expect((await login(next, TEST_PASSWORD)).statusCode).toBe(200)
  })

  it('an instance MFA mandate reaches every /me route, not just the ones past it', async () => {
    // /api/me was prefix-matched in the exemption list, which quietly exempted
    // /me/password, /me/email, /me/preferences and /me/export — letting an
    // unenrolled user under a mandate change their address and download every
    // note they own, the exact reach the mandate exists to stop.
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    await setInstanceMfaRequirement(true)
    try {
      // Still reachable: reading who you are, and the enrolment surface itself.
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
      ).toBe(200)

      // Bodies are schema-valid on purpose: Fastify validates before the
      // preHandler runs, so an empty body would 400 without the mandate ever
      // being consulted and this would pass for the wrong reason.
      for (const req of [
        { method: 'GET' as const, url: '/api/me/export', body: undefined },
        { method: 'GET' as const, url: '/api/me/preferences', body: undefined },
        {
          method: 'POST' as const,
          url: '/api/me/password',
          body: { currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' },
        },
        {
          method: 'POST' as const,
          url: '/api/me/email',
          body: { email: uniqueEmail('blocked'), password: TEST_PASSWORD },
        },
        {
          method: 'PUT' as const,
          url: '/api/me/preferences',
          body: { emailNotifications: false },
        },
      ]) {
        const res = await app.inject({
          method: req.method,
          url: req.url,
          headers: { cookie },
          ...(req.body ? { body: req.body } : {}),
        })
        expect(res.statusCode, `${req.method} ${req.url} escaped the mandate`).toBe(403)
      }

      // And the password really was not changed by that attempt.
      expect((await login(user.email, TEST_PASSWORD)).statusCode).toBe(200)
    } finally {
      await setInstanceMfaRequirement(false)
    }
  })

  it('the email opt-out actually stops the mail, and never the in-app row', async () => {
    // Previously this was only tested as a column round-trip: reverting
    // notify.ts to ignore the flag passed the whole suite, because nothing in
    // server/test/ called notify() at all.
    const optedOut = await createActiveUser()
    const cookie = await loginCookie(app, optedOut.email)
    await app.inject({
      method: 'PUT',
      url: '/api/me/preferences',
      headers: { cookie },
      body: { emailNotifications: false },
    })

    const before = sentMails.length
    await notify({ recipientId: optedOut.id, type: 'vault_shared', message: 'quiet please' })
    expect(sentMails.slice(before).some((m) => m.to === optedOut.email)).toBe(false)

    // The in-app row is the activity feed and is never optional.
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, optedOut.id))
    expect(rows.some((r) => r.message === 'quiet please')).toBe(true)

    // And someone who left it on still gets the mail — a fixture of one
    // opted-out user cannot tell a working flag from a broken mailer.
    const optedIn = await createActiveUser()
    const mark = sentMails.length
    await notify({ recipientId: optedIn.id, type: 'vault_shared', message: 'mail me' })
    await new Promise((r) => setTimeout(r, 50))
    expect(sentMails.slice(mark).some((m) => m.to === optedIn.email)).toBe(true)
  })
})
