import { apiFetch, ApiError } from '../lib/api.js'

export interface SessionUser {
  id: string
  email: string
  status: string
  role: 'member' | 'admin'
  createdAt: string
}

export function getSession(): Promise<SessionUser> {
  return apiFetch<SessionUser>('/me')
}

export interface SetupInput {
  token: string
  email: string
  password: string
}

export function setupInstance(input: SetupInput): Promise<{ id: string }> {
  return apiFetch('/setup', { method: 'POST', body: JSON.stringify(input) })
}

export interface SignupInput {
  email: string
  password: string
}

export function signup(input: SignupInput): Promise<{ status: 'pending_approval' }> {
  return apiFetch('/signup', { method: 'POST', body: JSON.stringify(input) })
}

export interface VerifyEmailInput {
  email: string
  code: string
}

export function verifyEmail(input: VerifyEmailInput): Promise<{ status: 'verified' }> {
  return apiFetch('/verify-email', { method: 'POST', body: JSON.stringify(input) })
}

export interface LoginInput {
  email: string
  password: string
  totp?: string
}

export interface LoginResult {
  id: string
  email: string
  role: 'member' | 'admin'
}

export function login(input: LoginInput): Promise<LoginResult> {
  return apiFetch('/login', { method: 'POST', body: JSON.stringify(input) })
}

export function logout(): Promise<{ status: 'logged_out' }> {
  return apiFetch('/logout', { method: 'POST' })
}

export function requestPasswordReset(email: string): Promise<{ status: 'ok' }> {
  return apiFetch('/request-password-reset', { method: 'POST', body: JSON.stringify({ email }) })
}

export function resetPassword(token: string, password: string): Promise<{ status: 'password_updated' }> {
  return apiFetch('/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) })
}

/** True when a failed login's response is an MFA challenge, not a hard rejection. */
export function isMfaRequired(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    typeof err.body === 'object' &&
    err.body !== null &&
    'mfaRequired' in err.body &&
    (err.body as { mfaRequired: unknown }).mfaRequired === true
  )
}
