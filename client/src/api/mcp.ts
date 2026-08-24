import { apiFetch } from '../lib/api.js'

export type McpScope = 'account' | 'vault' | 'repository'

export interface McpConnection {
  id: string
  name: string
  scope: McpScope
  vaultId: string | null
  repositoryId: string | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

// Only the create response carries the raw token, and only once.
export interface McpConnectionWithToken extends McpConnection {
  token: string
}

/**
 * Every connection the caller owns, across every scope — the server has no
 * filter param. Callers (this vault panel, later the account-wide list)
 * filter client-side.
 */
export function listMcpConnections(): Promise<McpConnection[]> {
  return apiFetch('/mcp-connections')
}

export function createVaultMcpConnection(name: string, vaultId: string): Promise<McpConnectionWithToken> {
  return apiFetch('/mcp-connections', {
    method: 'POST',
    body: JSON.stringify({ name, scope: 'vault', vaultId }),
  })
}

export function revokeMcpConnection(id: string): Promise<{ status: 'revoked' }> {
  return apiFetch(`/mcp-connections/${id}/revoke`, { method: 'POST' })
}
