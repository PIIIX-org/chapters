import { apiFetch } from '../lib/api.js'

/** Account-level settings: credentials, MFA, notification delivery, export. */

export interface ChangeEmailInput {
  email: string
  /** Re-authentication: the server rejects an email change without it. */
  password: string
}

/**
 * Clears `emailVerifiedAt` and mails a new code, so the caller is locked out
 * of login until they verify the new address. Say so before calling this.
 * A 409 means some other account already has that address.
 */
export function changeEmail(input: ChangeEmailInput): Promise<{ status: 'verification_sent' }> {
  return apiFetch('/me/email', { method: 'POST', body: JSON.stringify(input) })
}

export interface ChangePasswordInput {
  currentPassword: string
  newPassword: string
}

/** Every other session is destroyed; the caller's own survives. */
export function changePassword(
  input: ChangePasswordInput,
): Promise<{ status: 'password_changed' }> {
  return apiFetch('/me/password', { method: 'POST', body: JSON.stringify(input) })
}

export interface MfaSetup {
  secret: string
  /** otpauth:// URI for an authenticator app. */
  uri: string
}

/** Provisions a pending secret. Not active until `enableMfa` succeeds. */
export function startMfaSetup(): Promise<MfaSetup> {
  return apiFetch('/mfa/setup', { method: 'POST' })
}

/** Backup codes come back exactly once, here. */
export function enableMfa(code: string): Promise<{ status: 'enabled'; backupCodes: string[] }> {
  return apiFetch('/mfa/enable', { method: 'POST', body: JSON.stringify({ code }) })
}

/** 403s while the instance mandates MFA — don't offer this in that state. */
export function disableMfa(code: string): Promise<{ status: 'disabled' }> {
  return apiFetch('/mfa/disable', { method: 'POST', body: JSON.stringify({ code }) })
}

export interface NotificationPreferences {
  /**
   * In-app notifications are not covered: they are the activity feed, and the
   * notifications spec depends on that being a complete historical record.
   */
  emailNotifications: boolean
}

export function getNotificationPreferences(): Promise<NotificationPreferences> {
  return apiFetch('/me/preferences')
}

export function updateNotificationPreferences(
  input: NotificationPreferences,
): Promise<NotificationPreferences> {
  return apiFetch('/me/preferences', { method: 'PUT', body: JSON.stringify(input) })
}

/** Sets the instance-wide MFA mandate. Admin only. */
export function setMfaRequirement(required: boolean): Promise<{ required: boolean }> {
  return apiFetch('/admin/mfa-requirement', { method: 'PUT', body: JSON.stringify({ required }) })
}

/**
 * A zip of every vault the caller owns. Like the instance backup, this is not
 * JSON — a plain same-origin link carries the session cookie and streams it to
 * disk, where `apiFetch` would try to parse it.
 */
export const ACCOUNT_EXPORT_URL = '/api/me/export'
