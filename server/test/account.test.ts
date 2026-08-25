import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { ensureInstanceState } from '../src/auth/bootstrap.js'
import { setInstanceMfaRequirement } from '../src/auth/mfa.js'
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
