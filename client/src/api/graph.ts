import { apiFetch } from '../lib/api.js'

export interface CommunityNode {
  id: string
  community: number
  size: number
  noteCount: number
  codeCount: number
  lastActivity: string | null
}

export interface CommunityEdge {
  source: string
  target: string
  weight: number
}

export interface CommunityGraph {
  aggregated: true
  nodes: CommunityNode[]
  edges: CommunityEdge[]
  cappedGroups: string[]
}

export interface GraphNode {
  id: string
  resourceType: 'note' | 'code'
  resourceId: string
  path: string
  type: string | null
  tags: string[]
  timestamp: string | null
  updatedAt: string | null
  community: number
}

export interface GraphEdge {
  source: string
  target: string
  kind: 'extracted' | 'structural' | 'semantic'
}

export interface VaultGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  cappedGroups: string[]
  memberTotal?: number
}

export interface GraphFilters {
  types?: string[]
  tags?: string[]
  since?: string
  until?: string
}

export interface FetchGraphOptions {
  vaultId: string | null
  community: number | null
  filters: GraphFilters
}

export function fetchGraph(opts: FetchGraphOptions): Promise<VaultGraph | CommunityGraph> {
  const path = opts.vaultId ? `/vaults/${opts.vaultId}/graph` : '/graph/merged'

  const params = new URLSearchParams()
  // Server checks `aggregate` before `community` (assemble.ts:368) — sending
  // both makes drill-down silently return the aggregated graph, so these
  // two are mutually exclusive on the wire.
  if (opts.community === null) params.set('aggregate', 'community')
  else params.set('community', String(opts.community))

  if (opts.filters.types?.length) params.set('types', opts.filters.types.join(','))
  if (opts.filters.tags?.length) params.set('tags', opts.filters.tags.join(','))
  if (opts.filters.since) params.set('since', opts.filters.since)
  if (opts.filters.until) params.set('until', opts.filters.until)

  return apiFetch(`${path}?${params.toString()}`)
}
