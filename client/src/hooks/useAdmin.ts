import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveUser,
  deactivateUser,
  forceRevokeMcpConnection,
  forceRevokeShare,
  getAdminStats,
  listAdminMcpConnections,
  listAdminShares,
  listAdminTeams,
  listAdminUsers,
  listAdminVaults,
  listAuditTrail,
  listSecurityEvents,
  promoteUser,
  transferVaultOwner,
} from '../api/admin.js'
import type {
  AdminMcpConnection,
  AdminShare,
  AdminStats,
  AdminTeam,
  AdminUser,
  AdminVault,
  AuditEntry,
  SecurityEvent,
} from '../api/admin.js'
import type { ApiError } from '../lib/api.js'

export const ADMIN_USERS_KEY = ['admin', 'users'] as const
export const ADMIN_STATS_KEY = ['admin', 'stats'] as const
export const ADMIN_VAULTS_KEY = ['admin', 'vaults'] as const
export const ADMIN_TEAMS_KEY = ['admin', 'teams'] as const
export const ADMIN_SHARES_KEY = ['admin', 'shares'] as const
export const ADMIN_MCP_KEY = ['admin', 'mcp-connections'] as const
export const adminSecurityEventsKey = (offset: number) => ['admin', 'security-events', offset] as const
export const adminAuditKey = (offset: number) => ['admin', 'audit-trail', offset] as const

export function useAdminUsers(status?: AdminUser['status']) {
  return useQuery<AdminUser[], ApiError>({
    queryKey: [...ADMIN_USERS_KEY, status ?? 'all'],
    queryFn: () => listAdminUsers(status),
  })
}

export function useAdminStats() {
  return useQuery<AdminStats, ApiError>({ queryKey: ADMIN_STATS_KEY, queryFn: getAdminStats })
}

export function useAdminVaults() {
  return useQuery<AdminVault[], ApiError>({ queryKey: ADMIN_VAULTS_KEY, queryFn: listAdminVaults })
}

export function useAdminTeams() {
  return useQuery<AdminTeam[], ApiError>({ queryKey: ADMIN_TEAMS_KEY, queryFn: listAdminTeams })
}

export function useAdminShares() {
  return useQuery<AdminShare[], ApiError>({ queryKey: ADMIN_SHARES_KEY, queryFn: listAdminShares })
}

export function useAdminMcpConnections() {
  return useQuery<AdminMcpConnection[], ApiError>({
    queryKey: ADMIN_MCP_KEY,
    queryFn: listAdminMcpConnections,
  })
}

export function useSecurityEvents(limit: number, offset: number) {
  return useQuery<SecurityEvent[], ApiError>({
    queryKey: adminSecurityEventsKey(offset),
    queryFn: () => listSecurityEvents(limit, offset),
  })
}

export function useAuditTrail(limit: number, offset: number) {
  return useQuery<AuditEntry[], ApiError>({
    queryKey: adminAuditKey(offset),
    queryFn: () => listAuditTrail(limit, offset),
  })
}

// Every user mutation moves a row between status buckets and changes the
// aggregate counts, so both invalidate together. `ADMIN_USERS_KEY` is a
// prefix, not exact — the queue ('pending_approval') and the roster ('all')
// are separate cache entries of the same data.
function useUserMutation<T>(fn: (id: string) => Promise<T>) {
  const queryClient = useQueryClient()
  return useMutation<T, ApiError, string>({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY })
      void queryClient.invalidateQueries({ queryKey: ADMIN_STATS_KEY })
    },
  })
}

export function useApproveUser() {
  return useUserMutation(approveUser)
}

export function usePromoteUser() {
  return useUserMutation(promoteUser)
}

// Deactivation cascades server-side into sessions, team memberships and
// direct shares, so the share and team tables are stale afterwards too.
export function useDeactivateUser() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'deactivated' }, ApiError, string>({
    mutationFn: deactivateUser,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY })
      void queryClient.invalidateQueries({ queryKey: ADMIN_STATS_KEY })
      void queryClient.invalidateQueries({ queryKey: ADMIN_SHARES_KEY })
      void queryClient.invalidateQueries({ queryKey: ADMIN_TEAMS_KEY })
    },
  })
}

export function useTransferVaultOwner() {
  const queryClient = useQueryClient()
  return useMutation<{ ownerId: string }, ApiError, { vaultId: string; newOwnerId: string }>({
    mutationFn: ({ vaultId, newOwnerId }) => transferVaultOwner(vaultId, newOwnerId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_VAULTS_KEY })
    },
  })
}

export function useForceRevokeShare() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'revoked' }, ApiError, string>({
    mutationFn: forceRevokeShare,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_SHARES_KEY })
      void queryClient.invalidateQueries({ queryKey: ADMIN_VAULTS_KEY })
    },
  })
}

export function useForceRevokeMcpConnection() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'revoked' }, ApiError, string>({
    mutationFn: forceRevokeMcpConnection,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_MCP_KEY })
      void queryClient.invalidateQueries({ queryKey: ADMIN_STATS_KEY })
    },
  })
}
