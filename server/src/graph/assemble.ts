import { UndirectedGraph } from 'graphology'
import louvainModule from 'graphology-communities-louvain'
import { and, inArray, isNull, or } from 'drizzle-orm'

/** louvain ships CJS-flavored typings that fight NodeNext default imports. */
type LouvainFn = (graph: UndirectedGraph) => Record<string, number>
const louvain = ((louvainModule as { default?: unknown }).default ??
  louvainModule) as LouvainFn
import { db } from '../db/client.js'
import {
  noteLinks,
  notes,
  repositories,
  repositoryFileImports,
  repositoryFiles,
  semanticEdges,
} from '../db/schema.js'

export type ResourceType = 'note' | 'code'

export interface GraphNode {
  id: string
  resourceType: ResourceType
  resourceId: string // vaultId for notes, repositoryId for code
  path: string
  type: string | null // note OKF type, or detected language for code
  tags: string[] // notes only, empty for code
  timestamp: string | null // notes only, null for code
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

export interface GraphResourceSet {
  vaultIds: string[]
  repositoryIds: string[]
}

interface InternalNode {
  id: string
  resourceType: ResourceType
  resourceId: string
  path: string
  type: string | null
  tags: string[]
  timestamp: string | null
}

function passesFilters(node: InternalNode, filters: GraphFilters): boolean {
  if (filters.types && (!node.type || !filters.types.includes(node.type))) return false
  if (filters.tags && !filters.tags.some((t) => node.tags.includes(t))) return false
  if (filters.since && (!node.timestamp || node.timestamp < filters.since)) return false
  if (filters.until && (!node.timestamp || node.timestamp > filters.until)) return false
  return true
}

/**
 * Assembles the graph for a set of vaults and repositories the caller
 * has already been authorized for (callers re-resolve access live —
 * audit rule). Notes and repository files are unioned into one node
 * set (spec 9) — same edge kinds, same Louvain pass, now spanning two
 * content types.
 */
export async function buildGraph(
  resources: GraphResourceSet,
  filters: GraphFilters = {},
): Promise<VaultGraph> {
  const { vaultIds, repositoryIds } = resources
  if (vaultIds.length === 0 && repositoryIds.length === 0) {
    return { nodes: [], edges: [], cappedGroups: [] }
  }

  let internalNodes: InternalNode[] = []

  if (vaultIds.length > 0) {
    const noteRows = await db
      .select({
        id: notes.id,
        vaultId: notes.vaultId,
        path: notes.path,
        type: notes.type,
        frontmatter: notes.frontmatter,
      })
      .from(notes)
      .where(and(inArray(notes.vaultId, vaultIds), isNull(notes.deletedAt)))
    for (const r of noteRows) {
      const fm = r.frontmatter as { tags?: string[]; timestamp?: string }
      internalNodes.push({
        id: r.id,
        resourceType: 'note',
        resourceId: r.vaultId,
        path: r.path,
        type: r.type,
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        timestamp: typeof fm.timestamp === 'string' ? fm.timestamp : null,
      })
    }
  }

  if (repositoryIds.length > 0) {
    const fileRows = await db
      .select({
        id: repositoryFiles.id,
        repositoryId: repositoryFiles.repositoryId,
        path: repositoryFiles.path,
        language: repositoryFiles.language,
      })
      .from(repositoryFiles)
      .where(inArray(repositoryFiles.repositoryId, repositoryIds))
    for (const r of fileRows) {
      internalNodes.push({
        id: r.id,
        resourceType: 'code',
        resourceId: r.repositoryId,
        path: r.path,
        type: r.language,
        tags: [],
        timestamp: null,
      })
    }
  }

  internalNodes = internalNodes.filter((n) => passesFilters(n, filters))

  const byId = new Map(internalNodes.map((n) => [n.id, n]))
  const noteByVaultPath = new Map(
    internalNodes.filter((n) => n.resourceType === 'note').map((n) => [`${n.resourceId}:${n.path}`, n.id]),
  )
  const codeByRepoPath = new Map(
    internalNodes.filter((n) => n.resourceType === 'code').map((n) => [`${n.resourceId}:${n.path}`, n.id]),
  )
  const noteIds = internalNodes.filter((n) => n.resourceType === 'note').map((n) => n.id)
  const codeIds = internalNodes.filter((n) => n.resourceType === 'code').map((n) => n.id)

  // repo:<name>/<path> wikilinks resolve only against repositories already
  // in this call's own resource set — never a wider lookup.
  const repoNameToId =
    repositoryIds.length > 0
      ? new Map(
          (
            await db
              .select({ id: repositories.id, name: repositories.name })
              .from(repositories)
              .where(inArray(repositories.id, repositoryIds))
          ).map((r) => [r.name, r.id]),
        )
      : new Map<string, string>()

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
    // EXTRACTED: plain wikilinks resolve within the source note's own
    // vault; a `repo:<name>/<path>` link resolves against a repository
    // already in this call's resource set (cross-type — spec 9).
    const links = await db.select().from(noteLinks).where(inArray(noteLinks.sourceNoteId, noteIds))
    for (const link of links) {
      const source = byId.get(link.sourceNoteId)
      if (!source) continue
      if (link.targetPath.startsWith('repo:')) {
        const [repoName, ...pathParts] = link.targetPath.slice('repo:'.length).split('/')
        const repositoryId = repoName ? repoNameToId.get(repoName) : undefined
        const targetId = repositoryId ? codeByRepoPath.get(`${repositoryId}:${pathParts.join('/')}`) : undefined
        if (targetId) addEdge(link.sourceNoteId, targetId, 'extracted')
        continue
      }
      const targetId = noteByVaultPath.get(`${source.resourceId}:${link.targetPath}`)
      if (targetId) addEdge(link.sourceNoteId, targetId, 'extracted')
    }
  }

  if (codeIds.length > 0) {
    // EXTRACTED: code imports resolved within the same repository.
    const imports = await db
      .select()
      .from(repositoryFileImports)
      .where(inArray(repositoryFileImports.sourceFileId, codeIds))
    for (const imp of imports) {
      if (imp.resolvedTargetFileId && byId.has(imp.resolvedTargetFileId)) {
        addEdge(imp.sourceFileId, imp.resolvedTargetFileId, 'extracted')
      }
    }
  }

  if (internalNodes.length > 0) {
    // Semantic: stored pairs (now spanning notes and code — spec 9)
    // filtered to the permitted, live node set.
    const allIds = [...byId.keys()]
    const sem = await db
      .select()
      .from(semanticEdges)
      .where(or(inArray(semanticEdges.nodeAId, allIds), inArray(semanticEdges.nodeBId, allIds)))
    for (const edge of sem) {
      if (byId.has(edge.nodeAId) && byId.has(edge.nodeBId)) {
        addEdge(edge.nodeAId, edge.nodeBId, 'semantic')
      }
    }
  }

  // Structural: notes group by type/tag (existing); code groups by
  // language (global, mirrors note type) and by top-level directory
  // (per-repository — "same folder" only means something within one repo).
  const cappedGroups: string[] = []
  const groups = new Map<string, string[]>()
  const addToGroup = (key: string, id: string) => {
    const list = groups.get(key)
    if (list) list.push(id)
    else groups.set(key, [id])
  }
  for (const n of internalNodes) {
    if (n.resourceType === 'note') {
      addToGroup(`type:${n.type}`, n.id)
      for (const tag of n.tags) addToGroup(`tag:${tag}`, n.id)
    } else {
      if (n.type) addToGroup(`language:${n.type}`, n.id)
      const topDir = n.path.includes('/') ? n.path.split('/')[0] : '.'
      addToGroup(`dir:${n.resourceId}:${topDir}`, n.id)
    }
  }
  for (const [key, ids] of groups) {
    if (ids.length > STRUCTURAL_GROUP_CAP) {
      // ponytail: pairwise edges for huge groups are an unreadable hairball;
      // color-by-type/tag/language conveys the grouping instead. Capped, reported.
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
  const communities: Record<string, number> = g.order > 0 && g.size > 0 ? louvain(g) : {}

  const nodes: GraphNode[] = internalNodes.map((n) => ({
    ...n,
    community: communities[n.id] ?? 0,
  }))

  return { nodes, edges, cappedGroups }
}
