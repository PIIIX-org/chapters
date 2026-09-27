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

export interface LocalGraphNode {
  id: string
  path: string
  name: string
  title: string | null
  type: string | null
  resourceType: 'note' | 'code'
  resourceId: string
  isCenter: boolean
  depth: number
}

export interface LocalGraphEdge {
  source: string
  target: string
  kind: 'extracted' | 'semantic'
  similarity?: number
}

export interface LocalGraphData {
  center: LocalGraphNode
  nodes: LocalGraphNode[]
  edges: LocalGraphEdge[]
}

export function fetchLocalGraph(
  vaultId: string,
  path: string,
  depth = 1,
): Promise<LocalGraphData> {
  const params = new URLSearchParams()
  if (depth > 1) params.set('depth', String(depth))
  const qs = params.toString() ? `?${params.toString()}` : ''
  return apiFetch(`/vaults/${vaultId}/local-graph/${path}${qs}`)
}

export interface PathFindingResult {
  found: boolean
  nodes: GraphNode[]
  edges: GraphEdge[]
  distance: number
}

/**
 * Finds the shortest path connecting two nodes in a graph via BFS.
 * Instant client-side computation over already-loaded graph nodes and edges.
 */
export function findShortestPath(
  nodes: GraphNode[],
  edges: GraphEdge[],
  sourceId: string,
  targetId: string,
): PathFindingResult {
  if (sourceId === targetId) {
    const node = nodes.find((n) => n.id === sourceId)
    return node
      ? { found: true, nodes: [node], edges: [], distance: 0 }
      : { found: false, nodes: [], edges: [], distance: -1 }
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  if (!nodeMap.has(sourceId) || !nodeMap.has(targetId)) {
    return { found: false, nodes: [], edges: [], distance: -1 }
  }

  const adj = new Map<string, Array<{ neighborId: string; edge: GraphEdge }>>()
  for (const edge of edges) {
    let sList = adj.get(edge.source)
    if (!sList) {
      sList = []
      adj.set(edge.source, sList)
    }
    sList.push({ neighborId: edge.target, edge })

    let tList = adj.get(edge.target)
    if (!tList) {
      tList = []
      adj.set(edge.target, tList)
    }
    tList.push({ neighborId: edge.source, edge })
  }

  const queue: string[] = [sourceId]
  const visited = new Set<string>([sourceId])
  const prev = new Map<string, { prevId: string; edge: GraphEdge }>()

  let found = false
  while (queue.length > 0) {
    const curr = queue.shift()!
    if (curr === targetId) {
      found = true
      break
    }
    const neighbors = adj.get(curr) ?? []
    for (const { neighborId, edge } of neighbors) {
      if (!visited.has(neighborId)) {
        visited.add(neighborId)
        prev.set(neighborId, { prevId: curr, edge })
        queue.push(neighborId)
      }
    }
  }

  if (!found) {
    return { found: false, nodes: [], edges: [], distance: -1 }
  }

  const pathNodes: GraphNode[] = []
  const pathEdges: GraphEdge[] = []
  let curr = targetId
  while (curr !== sourceId) {
    const node = nodeMap.get(curr)
    if (node) pathNodes.unshift(node)
    const step = prev.get(curr)!
    pathEdges.unshift(step.edge)
    curr = step.prevId
  }
  const sourceNode = nodeMap.get(sourceId)
  if (sourceNode) pathNodes.unshift(sourceNode)

  return {
    found: true,
    nodes: pathNodes,
    edges: pathEdges,
    distance: pathEdges.length,
  }
}

export function fetchGraphPath(
  vaultId: string | null,
  source: string,
  target: string,
): Promise<PathFindingResult> {
  const basePath = vaultId ? `/vaults/${vaultId}/graph/path` : '/graph/merged/path'
  const params = new URLSearchParams({ source, target })
  return apiFetch(`${basePath}?${params.toString()}`)
}

export interface GraphPerspective {
  id: string
  vaultId: string | null
  userId: string
  name: string
  filters: GraphFilters & { colorMode?: string }
  isShared: boolean
  createdAt: string
  updatedAt: string
}

export function fetchGraphPerspectives(vaultId?: string | null): Promise<GraphPerspective[]> {
  const params = new URLSearchParams()
  if (vaultId) params.set('vaultId', vaultId)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return apiFetch(`/graph/perspectives${qs}`)
}

export function saveGraphPerspective(data: {
  name: string
  vaultId?: string | null
  filters?: GraphFilters & { colorMode?: string }
  isShared?: boolean
}): Promise<GraphPerspective> {
  return apiFetch('/graph/perspectives', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function deleteGraphPerspective(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/graph/perspectives/${id}`, {
    method: 'DELETE',
  })
}

