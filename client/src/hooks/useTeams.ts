import { useQuery } from '@tanstack/react-query'
import { listTeamMembers, listTeams, listTeamStats } from '../api/teams.js'
import type { Team, TeamMember, TeamMemberStats } from '../api/teams.js'
import type { ApiError } from '../lib/api.js'

export const TEAMS_QUERY_KEY = ['teams'] as const
export const teamMembersQueryKey = (teamId: string) => ['teams', teamId, 'members'] as const
export const teamStatsQueryKey = (teamId: string) => ['teams', teamId, 'stats'] as const

/** Only the teams the caller belongs to. */
export function useTeams() {
  return useQuery<Team[], ApiError>({
    queryKey: TEAMS_QUERY_KEY,
    queryFn: listTeams,
  })
}

// `enabled` defaults off for an empty id — the caller passes '' while its
// team list is still loading, and this must not fire a request for it.
export function useTeamMembers(teamId: string) {
  return useQuery<TeamMember[], ApiError>({
    queryKey: teamMembersQueryKey(teamId),
    queryFn: () => listTeamMembers(teamId),
    enabled: teamId !== '',
  })
}

/** Aggregate-only per-member stats — never per-note. See server route for the privacy rule. */
export function useTeamStats(teamId: string) {
  return useQuery<TeamMemberStats[], ApiError>({
    queryKey: teamStatsQueryKey(teamId),
    queryFn: () => listTeamStats(teamId),
    enabled: teamId !== '',
  })
}
