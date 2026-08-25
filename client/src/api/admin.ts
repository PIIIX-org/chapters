import { apiFetch } from '../lib/api.js'

/**
 * Admin oversight — metadata only, never note content
 * (`2026-07-15-admin-oversight-dashboard-design.md`). Nothing in this module
 * reads a note body, a frontmatter value or a revision diff, because no
 * endpoint behind it serves one.
 */

export interface AdminUser {
  id: string
  email: string
  status: 'pending_approval' | 'active' | 'deactivated'
  role: 'member' | 'admin'
  /** Login needs an approved status AND this — see the approval queue copy. */
  emailVerifiedAt: string | null
  createdAt: string
}

export interface AdminStats {
  usersByStatus: { status: string; count: number }[]
  vaults: number
  teams: number
  notes: number
  storageBytes: number
  activeMcpConnections: number
}

export interface AdminVault {
  id: string
  name: string
  ownerEmail: string
  mergeable: boolean
  noteCount: number
  shareCount: number
  lastActivity: string | null
}

export interface AdminTeam {
  id: string
  name: string
  memberCount: number
}

export interface AdminShare {
  id: string
  vaultId: string
  granteeType: 'user' | 'team'
  granteeId: string
  permission: 'read' | 'edit'
  createdAt: string
}

export interface AdminMcpConnection {
  id: string
  name: string
  scope: 'account' | 'vault' | 'repository'
  userEmail: string
  vaultId: string | null
  repositoryId: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export interface SecurityEvent {
  id: string
  type: string
  actorUserId: string | null
  subjectUserId: string | null
  mcpConnectionId: string | null
  ip: string | null
  detail: unknown
  createdAt: string
}

/** Who touched which note, when. Never what the change said. */
export interface AuditEntry {
  id: string
  notePath: string
  vaultId: string
  actorType: string
  actorId: string | null
  action: string
  createdAt: string
}

export function listAdminUsers(status?: AdminUser['status']): Promise<AdminUser[]> {
  return apiFetch(status ? `/admin/users?status=${status}` : '/admin/users')
}

export function approveUser(id: string): Promise<{ status: 'active' }> {
  return apiFetch(`/admin/users/${id}/approve`, { method: 'POST' })
}

export function promoteUser(id: string): Promise<{ role: 'admin' }> {
  return apiFetch(`/admin/users/${id}/promote`, { method: 'POST' })
}

export function deactivateUser(id: string): Promise<{ status: 'deactivated' }> {
  return apiFetch(`/admin/users/${id}/deactivate`, { method: 'POST' })
}

export function transferVaultOwner(vaultId: string, newOwnerId: string): Promise<{ ownerId: string }> {
  return apiFetch(`/admin/vaults/${vaultId}/transfer-owner`, {
    method: 'POST',
    body: JSON.stringify({ newOwnerId }),
  })
}

export function getAdminStats(): Promise<AdminStats> {
  return apiFetch('/admin/stats')
}

export function listAdminVaults(): Promise<AdminVault[]> {
  return apiFetch('/admin/vaults')
}

export function listAdminTeams(): Promise<AdminTeam[]> {
  return apiFetch('/admin/teams')
}

export function listAdminShares(): Promise<AdminShare[]> {
  return apiFetch('/admin/shares')
}

export function listAdminMcpConnections(): Promise<AdminMcpConnection[]> {
  return apiFetch('/admin/mcp-connections')
}

/** Structural revocation, instance-wide — removes access, never grants read. */
export function forceRevokeShare(shareId: string): Promise<{ status: 'revoked' }> {
  return apiFetch(`/admin/shares/${shareId}`, { method: 'DELETE' })
}

export function forceRevokeMcpConnection(id: string): Promise<{ status: 'revoked' }> {
  return apiFetch(`/admin/mcp-connections/${id}/revoke`, { method: 'POST' })
}

export function listSecurityEvents(limit = 50, offset = 0): Promise<SecurityEvent[]> {
  return apiFetch(`/admin/security-events?limit=${limit}&offset=${offset}`)
}

export function listAuditTrail(limit = 50, offset = 0): Promise<AuditEntry[]> {
  return apiFetch(`/admin/audit-trail?limit=${limit}&offset=${offset}`)
}

/**
 * The backup is a zip, not JSON, so it cannot go through `apiFetch`. A plain
 * same-origin link carries the session cookie and lets the browser stream the
 * file straight to disk — no blob held in memory, no fetch wrapper needed.
 */
export const INSTANCE_BACKUP_URL = '/api/admin/backup'
