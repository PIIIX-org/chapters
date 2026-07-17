import { UndirectedGraph } from 'graphology'
import louvainModule from 'graphology-communities-louvain'
import { and, inArray, isNull } from 'drizzle-orm'

/** louvain ships CJS-flavored typings that fight NodeNext default imports. */
type LouvainFn = (graph: UndirectedGraph) => Record<string, number>
const louvain = ((louvainModule as { default?: unknown }).default ??
  louvainModule) as LouvainFn
import { db } from '../db/client.js'
import { noteLinks, notes, semanticEdges } from '../db/schema.js'

export interface GraphNode {
  id: string
  vaultId: string
  path: string
  type: string
  tags: string[]
  timestamp: string | null
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
  /** Structural groups skipped because pairwise edges would explode (no silent caps). */
  cappedGroups: string[]
}

const STRUCTURAL_GROUP_CAP = 50

export interface GraphFilters {
  types?: string[]
  tags?: string[]
  since?: string
  until?: string
}

/**
 * Assembles the graph for a set of vaults the caller has already been
 * authorized for (callers re-resolve access live — audit rule). Multiple
 * vaults → merged view; cross-vault structural/semantic edges appear
 * naturally, extracted links resolve within their own vault only.
 */
export async function buildGraph(
  vaultIds: string[],
  filters: GraphFilters = {},
): Promise<VaultGraph> {
  if (vaultIds.length === 0) return { nodes: [], edges: [], cappedGroups: [] }

  let rows = await db
    .select({
      id: notes.id,
      vaultId: notes.vaultId,
      path: notes.path,
      type: notes.type,
      frontmatter: notes.frontmatter,
    })
    .from(notes)
    .where(and(inArray(notes.vaultId, vaultIds), isNull(notes.deletedAt)))

  const meta = new Map(
    rows.map((r) => {
      const fm = r.frontmatter as { tags?: string[]; timestamp?: string }
      return [
        r.id,
        {
          tags: Array.isArray(fm.tags) ? fm.tags : [],
          timestamp: typeof fm.timestamp === 'string' ? fm.timestamp : null,
        },
      ] as const
    }),
  )

  rows = rows.filter((r) => {
    const m = meta.get(r.id)!
    if (filters.types && !filters.types.includes(r.type)) return false
    if (filters.tags && !filters.tags.some((t) => m.tags.includes(t))) return false
    if (filters.since && (!m.timestamp || m.timestamp < filters.since)) return false
    if (filters.until && (!m.timestamp || m.timestamp > filters.until)) return false
    return true
  })

  const byId = new Map(rows.map((r) => [r.id, r]))
  const byVaultPath = new Map(rows.map((r) => [`${r.vaultId}:${r.path}`, r.id]))
  const noteIds = [...byId.keys()]
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  const addEdge = (a: string, b: string, kind: GraphEdge['kind']) => {
    if (a === b) return
    const key = a < b ? `${a}|${b}|${kind}` : `${b}|${a}|${kind}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ source: a, target: b, kind })
  }

  if (noteIds.length > 0) {
    // EXTRACTED: wikilinks resolve within the source note's own vault.
    const links = await db
      .select()
      .from(noteLinks)
      .where(inArray(noteLinks.sourceNoteId, noteIds))
    for (const link of links) {
      const source = byId.get(link.sourceNoteId)
      if (!source) continue
      const targetId = byVaultPath.get(`${source.vaultId}:${link.targetPath}`)
      if (targetId) addEdge(link.sourceNoteId, targetId, 'extracted')
    }

    // Semantic: stored pairs filtered to the permitted, live node set.
    const sem = await db
      .select()
      .from(semanticEdges)
      .where(inArray(semanticEdges.noteA, noteIds))
    for (const edge of sem) {
      if (byId.has(edge.noteB)) addEdge(edge.noteA, edge.noteB, 'semantic')
    }
  }

  // Structural: shared type or overlapping tags, group-capped.
  const cappedGroups: string[] = []
  const groups = new Map<string, string[]>()
  for (const r of rows) {
    ;(groups.get(`type:${r.type}`) ?? groups.set(`type:${r.type}`, []).get(`type:${r.type}`))!.push(
      r.id,
    )
    for (const tag of meta.get(r.id)!.tags) {
      ;(groups.get(`tag:${tag}`) ?? groups.set(`tag:${tag}`, []).get(`tag:${tag}`))!.push(r.id)
    }
  }
  for (const [key, ids] of groups) {
    if (ids.length > STRUCTURAL_GROUP_CAP) {
      // ponytail: pairwise edges for huge groups are an unreadable hairball;
      // color-by-type/tag conveys the grouping instead. Capped, reported.
      cappedGroups.push(key)
      continue
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) addEdge(ids[i]!, ids[j]!, 'structural')
    }
  }

  // Louvain communities over the full assembled edge graph.
  const g = new UndirectedGraph()
  for (const id of byId.keys()) g.addNode(id)
  for (const e of edges) {
    if (!g.hasEdge(e.source, e.target)) g.addEdge(e.source, e.target)
  }
  const communities: Record<string, number> =
    g.order > 0 && g.size > 0 ? louvain(g) : {}

  const nodes: GraphNode[] = rows.map((r) => ({
    id: r.id,
    vaultId: r.vaultId,
    path: r.path,
    type: r.type,
    tags: meta.get(r.id)!.tags,
    timestamp: meta.get(r.id)!.timestamp,
    community: communities[r.id] ?? 0,
  }))

  return { nodes, edges, cappedGroups }
}
