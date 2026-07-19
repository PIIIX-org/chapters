import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import {
  getSession,
  isMfaRequired,
  login,
  logout,
  requestPasswordReset,
  resetPassword,
  setupInstance,
  signup,
  verifyEmail,
} from './auth'

describe('auth api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getSession calls GET /api/me', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJsonResponse(200, { id: 'u1', email: 'a@b.com', status: 'active', role: 'member', createdAt: '2026-01-01' }))
    vi.stubGlobal('fetch', fetchMock)

    const session = await getSession()

    expect(session.email).toBe('a@b.com')
    expect(fetchMock).toHaveBeenCalledWith('/api/me', expect.objectContaining({ credentials: 'include' }))
  })

  it('setupInstance posts to /api/setup with the token/email/password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'admin-1' }))
    vi.stubGlobal('fetch', fetchMock)

    await setupInstance({ token: 't', email: 'a@b.com', password: 'password123' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/setup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 't', email: 'a@b.com', password: 'password123' }),
      }),
    )
  })

  it('signup posts to /api/signup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'pending_approval' })))
    const result = await signup({ email: 'a@b.com', password: 'password123' })
    expect(result.status).toBe('pending_approval')
  })

  it('verifyEmail posts to /api/verify-email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'verified' })))
    const result = await verifyEmail({ email: 'a@b.com', code: '123456' })
    expect(result.status).toBe('verified')
  })

  it('login posts to /api/login and returns the session shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'u1', email: 'a@b.com', role: 'member' })),
    )
    const result = await login({ email: 'a@b.com', password: 'password123' })
    expect(result).toEqual({ id: 'u1', email: 'a@b.com', role: 'member' })
  })

  it('logout posts to /api/logout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'logged_out' })))
    const result = await logout()
    expect(result.status).toBe('logged_out')
  })

  it('requestPasswordReset posts to /api/request-password-reset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'ok' })))
    const result = await requestPasswordReset('a@b.com')
    expect(result.status).toBe('ok')
  })

  it('resetPassword posts to /api/reset-password', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'password_updated' })))
    const result = await resetPassword('tok', 'newpassword123')
    expect(result.status).toBe('password_updated')
  })

  it('isMfaRequired reads the mfaRequired flag off a failed login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'totp code required', mfaRequired: true })),
    )
    try {
      await login({ email: 'a@b.com', password: 'password123' })
      expect.unreachable()
    } catch (err) {
      expect(isMfaRequired(err)).toBe(true)
    }
  })

  it('isMfaRequired is false for a plain invalid-credentials error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'invalid credentials' })))
    try {
      await login({ email: 'a@b.com', password: 'wrong' })
      expect.unreachable()
    } catch (err) {
      expect(isMfaRequired(err)).toBe(false)
    }
  })
})
