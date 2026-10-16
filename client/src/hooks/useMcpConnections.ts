import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createMcpConnection, listMcpConnections, listMcpTools, revokeMcpConnection } from '../api/mcp.js'
import type { McpConnection, McpConnectionWithToken, McpMintOptions, McpTarget, McpToolInfo } from '../api/mcp.js'
import type { ApiError } from '../lib/api.js'

// Unscoped: every scope the caller owns comes back in one list. Shared by
// this vault-scoped panel today and the account-wide MCP list in a later
// unit, so both stay in sync off one cache entry.
export const MCP_CONNECTIONS_QUERY_KEY = ['mcp-connections'] as const
export const MCP_TOOLS_QUERY_KEY = ['mcp-connections', 'tools'] as const

export function useMcpConnections() {
  return useQuery<McpConnection[], ApiError>({
    queryKey: MCP_CONNECTIONS_QUERY_KEY,
    queryFn: () => listMcpConnections(),
  })
}

/** The tool catalog, fetched only once the allow-list picker is opened. */
export function useMcpTools(enabled: boolean) {
  return useQuery<McpToolInfo[], ApiError>({
    queryKey: MCP_TOOLS_QUERY_KEY,
    queryFn: () => listMcpTools(),
    enabled,
    staleTime: Infinity,
  })
}

// One hook for both scopes, so the panel picks a target instead of picking a
// hook — a conditional hook call would break the rules of hooks.
export function useCreateMcpConnection(target: McpTarget) {
  const queryClient = useQueryClient()
  return useMutation<McpConnectionWithToken, ApiError, McpMintOptions>({
    mutationFn: (options) => createMcpConnection(target, options),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY, exact: true })
    },
  })
}

export function useRevokeMcpConnection() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'revoked' }, ApiError, string>({
    mutationFn: (id) => revokeMcpConnection(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY, exact: true })
    },
  })
}
