import { apiFetch } from '../lib/api.js'

export type McpScope = 'account' | 'vault' | 'repository'

/**
 * What a token may do, ordered read < write < admin; each MCP tool needs one
 * of them. Set when the token is minted, never raised later.
 */
export type McpAccess = 'read' | 'write' | 'admin'

/**
 * The tools a token lists and may call, nested reader < writer < admin
 * (#428): reader finds, reads and answers code questions, writer also
 * creates and edits notes, admin has every tool. It narrows `access`, never
 * widens it. Set when the token is minted.
 */
export type McpProfile = 'reader' | 'writer' | 'admin'

export interface McpConnection {
  id: string
  name: string
  scope: McpScope
  vaultId: string | null
  repositoryId: string | null
  access: McpAccess
  profile: McpProfile
  /** null: every tool `access` and `profile` permit. */
  allowedTools: string[] | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

/** What a connection is being created for — the two scopes the UI offers. */
export type McpTarget = { scope: 'vault'; vaultId: string } | { scope: 'account' }

/** The capabilities chosen at mint time. */
export interface McpMintOptions {
  name: string
  access: McpAccess
  profile: McpProfile
  /** Omitted: every tool `access` and `profile` permit. */
  allowedTools?: string[]
  /** ISO time; omitted: never expires. */
  expiresAt?: string
}

/** One MCP tool as the server registers it. */
export interface McpToolInfo {
  name: string
  scope: 'account' | 'vault' | 'vault-or-account' | 'repository' | 'repository-or-account' | 'vault-or-repo'
  capability: McpAccess
  /** The user's permission on a pinned vault or repository that the tool needs (#649). */
  pinPermission: 'read' | 'edit' | 'owner'
  /** The smallest profile the tool is in (#428). */
  profile: McpProfile
  /** MCP tool annotations (#434): `readOnlyHint` on reads; `destructiveHint` and, when true, `idempotentHint` on writes. */
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
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

/** Every MCP tool with the access level it needs, for the allow-list picker. */
export function listMcpTools(): Promise<McpToolInfo[]> {
  return apiFetch('/mcp-connections/tools')
}

export function createMcpConnection(target: McpTarget, options: McpMintOptions): Promise<McpConnectionWithToken> {
  return apiFetch('/mcp-connections', {
    method: 'POST',
    body: JSON.stringify({ ...target, ...options }),
  })
}

export function revokeMcpConnection(id: string): Promise<{ status: 'revoked' }> {
  return apiFetch(`/mcp-connections/${id}/revoke`, { method: 'POST' })
}
