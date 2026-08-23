import { apiFetch } from '../lib/api.js'

export type GranteeType = 'user' | 'team'
export type SharePermission = 'read' | 'edit'

export interface ShareMember {
  teamId: string
  userId: string
  email: string
}

export interface Share {
  id: string
  vaultId: string
  granteeType: GranteeType
  granteeId: string
  permission: SharePermission
  createdAt: string
  // Present only on user shares. Optional because granteeId has no FK.
  email?: string
  // Live expansion of a team share's current membership.
  members?: ShareMember[]
}

export interface Team {
  id: string
  name: string
  role: string
}

export function listShares(vaultId: string): Promise<Share[]> {
  return apiFetch(`/vaults/${vaultId}/shares`)
}

export function createShare(
  vaultId: string,
  body: { granteeType: GranteeType; granteeId: string; permission: SharePermission },
): Promise<Share> {
  return apiFetch(`/vaults/${vaultId}/shares`, { method: 'POST', body: JSON.stringify(body) })
}

export function revokeShare(vaultId: string, shareId: string): Promise<{ status: 'revoked' }> {
  return apiFetch(`/vaults/${vaultId}/shares/${shareId}`, { method: 'DELETE' })
}

/** The only route from an email to the UUID the share endpoint demands. */
export function lookupUserByEmail(email: string): Promise<{ id: string; email: string }> {
  return apiFetch(`/users/lookup?email=${encodeURIComponent(email)}`)
}

/** Only the caller's own teams — the server enforces this, not the client. */
export function listTeams(): Promise<Team[]> {
  return apiFetch('/teams')
}
