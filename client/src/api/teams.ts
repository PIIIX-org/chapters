import { apiFetch } from '../lib/api.js'

export interface Team {
  id: string
  name: string
  role: 'owner' | 'member'
}

export interface TeamMember {
  userId: string
  email: string
  role: string
}

/** One row per member, including idle ones — see server route for the privacy rule. */
export interface TeamMemberStats {
  userId: string
  email: string
  notesTouched: number
  vaultsTouched: number
  lastActivityAt: string | null
}

/** Only the caller's own teams — the server enforces this, not the client. */
export function listTeams(): Promise<Team[]> {
  return apiFetch('/teams')
}

export function listTeamMembers(teamId: string): Promise<TeamMember[]> {
  return apiFetch(`/teams/${teamId}/members`)
}

export function listTeamStats(teamId: string): Promise<TeamMemberStats[]> {
  return apiFetch(`/teams/${teamId}/stats`)
}

export function createTeam(name: string): Promise<Team> {
  return apiFetch('/teams', { method: 'POST', body: JSON.stringify({ name }) })
}

/** 404s (as an ApiError) when no active account has this exact email. */
export function lookupUserByEmail(email: string): Promise<{ id: string; email: string }> {
  return apiFetch(`/users/lookup?email=${encodeURIComponent(email)}`)
}

export function addTeamMember(teamId: string, userId: string): Promise<{ status: 'added' }> {
  return apiFetch(`/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ userId }) })
}

export function removeTeamMember(teamId: string, userId: string): Promise<{ status: 'removed' }> {
  return apiFetch(`/teams/${teamId}/members/${userId}`, { method: 'DELETE' })
}

export function deleteTeam(teamId: string): Promise<{ status: 'deleted' }> {
  return apiFetch(`/teams/${teamId}`, { method: 'DELETE' })
}
