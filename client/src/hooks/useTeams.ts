import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeamMembers,
  listTeams,
  listTeamStats,
  removeTeamMember,
} from '../api/teams.js'
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

export function useCreateTeam() {
  const queryClient = useQueryClient()
  return useMutation<Team, ApiError, string>({
    mutationFn: (name) => createTeam(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TEAMS_QUERY_KEY, exact: true })
    },
  })
}

export function useAddTeamMember(teamId: string) {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'added' }, ApiError, string>({
    mutationFn: (userId) => addTeamMember(teamId, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamMembersQueryKey(teamId) })
      void queryClient.invalidateQueries({ queryKey: teamStatsQueryKey(teamId) })
    },
  })
}

export function useRemoveTeamMember(teamId: string) {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'removed' }, ApiError, string>({
    mutationFn: (userId) => removeTeamMember(teamId, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamMembersQueryKey(teamId) })
      void queryClient.invalidateQueries({ queryKey: teamStatsQueryKey(teamId) })
    },
  })
}

export function useDeleteTeam() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'deleted' }, ApiError, string>({
    mutationFn: (teamId) => deleteTeam(teamId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TEAMS_QUERY_KEY, exact: true })
    },
  })
}
