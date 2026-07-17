import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as OTPAuth from 'otpauth'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { setInstanceMfaRequirement } from '../src/auth/mfa.js'
import { createActiveUser, loginCookie, TEST_PASSWORD } from './helpers.js'

let app: FastifyInstance

function codeFor(secret: string, email: string): string {
  return new OTPAuth.TOTP({
    issuer: 'Chapters',
    label: email,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate()
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await setInstanceMfaRequirement(false)
  await app.close()
})

describe('MFA', () => {
  it('enables TOTP, challenges every login, accepts backup codes once', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)

    const setup = (
      await app.inject({ method: 'POST', url: '/api/mfa/setup', headers: { cookie } })
    ).json() as { secret: string; uri: string }
    expect(setup.uri).toContain('otpauth://totp/')

    // Wrong code doesn't enable.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/mfa/enable',
      headers: { cookie },
      body: { code: '000000' },
    })
    expect(bad.statusCode).toBe(400)

    const enable = await app.inject({
      method: 'POST',
      url: '/api/mfa/enable',
      headers: { cookie },
      body: { code: codeFor(setup.secret, user.email) },
    })
    expect(enable.statusCode).toBe(200)
    const { backupCodes } = enable.json() as { backupCodes: string[] }
    expect(backupCodes).toHaveLength(10)

    // Password alone no longer logs in.
    const noCode = await app.inject({
      method: 'POST',
      url: '/api/login',
      body: { email: user.email, password: TEST_PASSWORD },
    })
    expect(noCode.statusCode).toBe(401)
    expect((noCode.json() as { mfaRequired?: boolean }).mfaRequired).toBe(true)

    // Password + TOTP works.
    const withCode = await app.inject({
      method: 'POST',
      url: '/api/login',
      body: { email: user.email, password: TEST_PASSWORD, totp: codeFor(setup.secret, user.email) },
    })
    expect(withCode.statusCode).toBe(200)

    // Backup code works exactly once.
    const backup = backupCodes[0]!
    const withBackup = await app.inject({
      method: 'POST',
      url: '/api/login',
      body: { email: user.email, password: TEST_PASSWORD, totp: backup },
    })
    expect(withBackup.statusCode).toBe(200)
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/login',
      body: { email: user.email, password: TEST_PASSWORD, totp: backup },
    })
    expect(reuse.statusCode).toBe(401)
  })

  it('admin mandate gates the API until the user sets up MFA', async () => {
    const admin = await createActiveUser({ role: 'admin' })
    const adminCookie = await loginCookie(app, admin.email)
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)

    const toggle = await app.inject({
      method: 'PUT',
      url: '/api/admin/mfa-requirement',
      headers: { cookie: adminCookie },
      body: { required: true },
    })
    expect(toggle.statusCode).toBe(200)

    // Regular API blocked...
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/vaults',
      headers: { cookie },
    })
    expect(blocked.statusCode).toBe(403)
    expect((blocked.json() as { mfaSetupRequired?: boolean }).mfaSetupRequired).toBe(true)

    // ...but the setup surface is reachable.
    const setup = await app.inject({ method: 'POST', url: '/api/mfa/setup', headers: { cookie } })
    expect(setup.statusCode).toBe(200)
    const { secret } = setup.json() as { secret: string }
    await app.inject({
      method: 'POST',
      url: '/api/mfa/enable',
      headers: { cookie },
      body: { code: codeFor(secret, user.email) },
    })

    // Session user snapshot refreshes on next request — now unblocked.
    const unblocked = await app.inject({
      method: 'GET',
      url: '/api/vaults',
      headers: { cookie },
    })
    expect(unblocked.statusCode).toBe(200)

    // Disabling MFA is refused while the mandate is on.
    const disable = await app.inject({
      method: 'POST',
      url: '/api/mfa/disable',
      headers: { cookie },
      body: { code: codeFor(secret, user.email) },
    })
    expect(disable.statusCode).toBe(403)

    await setInstanceMfaRequirement(false)
  })
})
