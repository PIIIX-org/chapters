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
