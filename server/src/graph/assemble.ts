import { UndirectedGraph } from 'graphology'
import louvainModule from 'graphology-communities-louvain'
import { and, inArray, isNull, sql } from 'drizzle-orm'

/** louvain ships CJS-flavored typings that fight NodeNext default imports. */
type LouvainFn = (
  graph: UndirectedGraph,
  options?: { rng?: () => number },
) => Record<string, number>
const louvain = ((louvainModule as { default?: unknown }).default ??
  louvainModule) as LouvainFn

/**
 * graphology-communities-louvain defaults to `rng: Math.random` — two
 * requests over the identical node/edge set (e.g. the aggregated Home
 * fetch, then a `?community=<n>` drill-down that rebuilds the graph from
 * scratch) can and do land on different community numbers whenever the
 * graph's structure is genuinely ambiguous, which is the normal case, not
 * an edge case. Seeding from the nodes' content keys (`resourceType:path`,
 * in node order) makes two runs over the same content produce the same rng
 * stream in any database (#1006), while two runs over different filtered
 * node sets still get different seeds. mulberry32: small, fast, good
 * enough distribution for tie-breaking — not a cryptographic requirement.
 */
function seedFromKeys(keys: Iterable<string>): number {
  let h = 2166136261
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h ^= 0x0a
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
import { db } from '../db/client.js'
import {
  noteLinks,
  notes,
  repositories,
  repositoryFileImports,
  repositoryFiles,
  semanticEdges,
} from '../db/schema.js'
import { compareCodeUnits } from '../mcp/response.js'

export type ResourceType = 'note' | 'code'

export interface GraphNode {
  id: string
  resourceType: ResourceType
  resourceId: string // vaultId for notes, repositoryId for code
  path: string
  type: string | null // note OKF type, or detected language for code
  tags: string[] // notes only, empty for code
  timestamp: string | null // notes only, null for code
  updatedAt: string | null
  community: number
}

export const EDGE_KINDS = ['extracted', 'structural', 'semantic'] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

/** Why an edge exists (ADR-004 §2.8); `kind` says how it was found. */
export type EdgeRelation = 'link' | 'import' | 'same_type' | 'same_tag' | 'same_language' | 'same_folder' | 'similar'

export interface GraphEdge {
  source: string
  target: string
  kind: EdgeKind
  /** True for links and imports: the source links to or imports the target. Structural and semantic edges have no direction. */
  directed: boolean
  relation: EdgeRelation
  /** `resolved` (links, resolved imports, shared groups), or a semantic edge's similarity (the higher of its two stored directions). */
  confidence: 'resolved' | number
  /**
   * Where the edge is written, as stored: `[start, end]` lines of the source
   * (a link: body-relative lines of its note; an import: the line of its
   * specifier), null when not known (an import extracted before migration
   * 0031, a link row not located yet) and for semantic edges; for a
   * structural edge the group (`type:`, `tag:`, `language:` or `folder:`).
   * `graph/edges.ts` renders it as `path#La-Lb` in whole-file lines.
   */
  evidence: readonly [number, number] | string | null
}

export interface VaultGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Structural groups skipped because pairwise edges would explode (no silent caps). */
  cappedGroups: string[]
  /** Pre-slice member count for a `?community=<n>` request; undefined on other paths. */
  memberTotal?: number
}

export const STRUCTURAL_GROUP_CAP = 50
/** Louvain communities can be huge; cap the member fetch so d3-force layout doesn't stall. */
export const COMMUNITY_MEMBER_CAP = 2500

export interface GraphFilters {
  types?: string[]
  tags?: string[]
  since?: string
  until?: string
  aggregate?: 'community'
  community?: number
  /** Edge kinds to build (default all); the others are never queried, so Louvain runs over these only (#426). */
  edgeTypes?: readonly EdgeKind[]
}

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

export interface GraphResourceSet {
  vaultIds: string[]
  repositoryIds: string[]
}

/** A graph node before Louvain gives it a community. */
export interface InternalNode {
  id: string
  resourceType: ResourceType
  resourceId: string
  path: string
  type: string | null
  tags: string[]
  timestamp: string | null
  updatedAt: string | null
}

/** The note columns a graph node is read from. */
export const NOTE_NODE_COLUMNS = {
  id: notes.id,
  vaultId: notes.vaultId,
  path: notes.path,
  type: notes.type,
  frontmatter: notes.frontmatter,
  updatedAt: notes.updatedAt,
}

export function noteNode(r: { id: string; vaultId: string; path: string; type: string; frontmatter: unknown; updatedAt: Date | null }): InternalNode {
  const fm = r.frontmatter as { tags?: string[]; timestamp?: string }
  return {
    id: r.id,
    resourceType: 'note',
    resourceId: r.vaultId,
    path: r.path,
    type: r.type,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    timestamp: typeof fm.timestamp === 'string' ? fm.timestamp : null,
    updatedAt: r.updatedAt?.toISOString() ?? null,
  }
}

/** The repository file columns a graph node is read from. */
export const FILE_NODE_COLUMNS = {
  id: repositoryFiles.id,
  repositoryId: repositoryFiles.repositoryId,
  path: repositoryFiles.path,
  language: repositoryFiles.language,
  updatedAt: repositoryFiles.updatedAt,
}

export function fileNode(r: { id: string; repositoryId: string; path: string; language: string | null; updatedAt: Date | null }): InternalNode {
  return {
    id: r.id,
    resourceType: 'code',
    resourceId: r.repositoryId,
    path: r.path,
    type: r.language,
    tags: [],
    timestamp: null,
    updatedAt: r.updatedAt?.toISOString() ?? null,
  }
}

/**
 * The order of graph nodes (#1006): path in code-unit order, then resource
 * type (`code` before `note`). The container and node ids decide only what
 * the content leaves tied: one path and type in two containers of a merged
 * graph.
 */
export const compareNodes = (a: Pick<InternalNode, 'id' | 'resourceType' | 'resourceId' | 'path'>, b: Pick<InternalNode, 'id' | 'resourceType' | 'resourceId' | 'path'>): number =>
  compareCodeUnits(a.path, b.path) || compareCodeUnits(a.resourceType, b.resourceType) || compareCodeUnits(a.resourceId, b.resourceId) || compareCodeUnits(a.id, b.id)

/**
 * The file a `repo:<name>/<path>` (or `code:`, or `<name>:<path>`) wikilink
 * names: `{repositoryId, path}` within `repositoryIds` (by name or id),
 * null when it names none, undefined for a plain note link.
 */
export function repoLinkTarget(
  targetPath: string,
  repoNameToId: ReadonlyMap<string, string>,
  repositoryIds: readonly string[],
): { repositoryId: string; path: string } | null | undefined {
  if (!targetPath.startsWith('repo:') && !targetPath.startsWith('code:')) return undefined
  const cleanPath = targetPath.slice('repo:'.length).split('#')[0] ?? ''
  if (!cleanPath) return null
  let repoKey = cleanPath
  let filePath = ''
  const colonIdx = cleanPath.indexOf(':')
  const slashIdx = cleanPath.indexOf('/')
  const cut = colonIdx !== -1 ? colonIdx : slashIdx
  if (cut !== -1) {
    repoKey = cleanPath.slice(0, cut)
    filePath = cleanPath.slice(cut + 1)
  }
  const repositoryId = (repoKey ? repoNameToId.get(repoKey) : undefined) ?? (repositoryIds.includes(repoKey) ? repoKey : undefined)
  return repositoryId ? { repositoryId, path: filePath } : null
}

/** Repository names to ids, for `repo:<name>/…` links: only the call's own repositories, never a wider lookup. */
export async function repositoryNames(repositoryIds: readonly string[]): Promise<Map<string, string>> {
  if (repositoryIds.length === 0) return new Map()
  const rows = await db
    .select({ id: repositories.id, name: repositories.name })
    .from(repositories)
    .where(inArray(repositories.id, [...repositoryIds]))
  return new Map(rows.map((r) => [r.name, r.id]))
}

/** A code file's top-level directory, `.` at the repository root: its `dir:` structural group. */
export const topDirectory = (path: string): string => (path.includes('/') ? path.split('/')[0]! : '.')

/**
 * The structural groups a node belongs to: notes by type and each tag, code
 * by language (across repositories) and top-level directory (per
 * repository: "same folder" means something within one repository only).
 */
export function groupKeys(n: InternalNode): string[] {
  if (n.resourceType === 'note') return [`type:${n.type}`, ...n.tags.map((tag) => `tag:${tag}`)]
  return [...(n.type ? [`language:${n.type}`] : []), `dir:${n.resourceId}:${topDirectory(n.path)}`]
}

/** The structural edge between two members of group `key` (`groupKeys`): its relation and the group as evidence. */
export function structuralEdge(source: string, target: string, key: string): GraphEdge {
  const at = key.indexOf(':')
  const prefix = key.slice(0, at)
  const relation = prefix === 'type' ? 'same_type' : prefix === 'tag' ? 'same_tag' : prefix === 'language' ? 'same_language' : 'same_folder'
  // `dir:<repositoryId>:<directory>`: the folder's name, both ends being in that repository.
  const evidence = prefix === 'dir' ? `folder:${key.slice(key.indexOf(':', at + 1) + 1)}` : key
  return { source, target, kind: 'structural', directed: false, relation, confidence: 'resolved', evidence }
}

/** A wikilink row as an edge from its note: its lines when located (0: not located yet). */
export const linkEdge = (source: string, target: string, startLine: number, endLine: number): GraphEdge => ({
  source,
  target,
  kind: 'extracted',
  directed: true,
  relation: 'link',
  confidence: 'resolved',
  evidence: startLine > 0 ? [startLine, endLine] : null,
})

/** A resolved import as an edge from the importing file: the line of its specifier when known. */
export const importEdge = (source: string, target: string, line: number | null): GraphEdge => ({
  source,
  target,
  kind: 'extracted',
  directed: true,
  relation: 'import',
  confidence: 'resolved',
  evidence: line === null ? null : [line, line],
})

/** A stored semantic row as an edge: undirected, its similarity as the confidence. */
export const semanticEdge = (source: string, target: string, similarity: number): GraphEdge => ({
  source,
  target,
  kind: 'semantic',
  directed: false,
  relation: 'similar',
  confidence: similarity,
  evidence: null,
})

const GROUP_RANK: readonly EdgeRelation[] = ['same_type', 'same_tag', 'same_language', 'same_folder']

/** Whether structural edge `a` names a better group than `b`: type, tag, language, folder; then the group in code-unit order. */
const betterGroup = (a: GraphEdge, b: GraphEdge): boolean =>
  GROUP_RANK.indexOf(a.relation) - GROUP_RANK.indexOf(b.relation) < 0 || (a.relation === b.relation && String(a.evidence) < String(b.evidence))

/**
 * Edges in the order first added; a self-edge is dropped (#558). A directed
 * edge (link, import) is kept per ordered pair and relation, so a→b and b→a
 * are two edges; written on several lines, it names the first. An
 * undirected one is kept per unordered pair and kind: a structural pair
 * sharing several groups names the best-ranked group, a semantic pair keeps
 * the higher similarity. So the whole graph and a neighbourhood give the
 * same rows whatever order they add them in; `buildGraph` then puts them in
 * content order (`contentOrder`).
 */
export class EdgeList {
  readonly edges: GraphEdge[] = []
  private readonly byKey = new Map<string, GraphEdge>()

  add(edge: GraphEdge): void {
    const { source: a, target: b } = edge
    if (a === b) return
    const pair = a < b ? `${a}|${b}|${edge.kind}` : `${b}|${a}|${edge.kind}`
    const key = edge.directed ? `${a}>${b}|${edge.relation}` : pair
    const seen = this.byKey.get(key)
    if (!seen) {
      this.byKey.set(key, edge)
      this.edges.push(edge)
    } else if (edge.directed) {
      const line = (edge.evidence as readonly [number, number] | null)?.[0]
      const seenLine = (seen.evidence as readonly [number, number] | null)?.[0]
      if (line !== undefined && (seenLine === undefined || line < seenLine)) seen.evidence = edge.evidence
    } else if (edge.kind === 'semantic' && (edge.confidence as number) > (seen.confidence as number)) {
      seen.confidence = edge.confidence
    } else if (edge.kind === 'structural' && betterGroup(edge, seen)) {
      seen.relation = edge.relation
      seen.evidence = edge.evidence
    }
  }
}

/** `YYYY-MM-DD`, optionally `THH:MM`, `:SS`, a fraction and `Z` or `±HH:MM`. */
const TIME_BOUND = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/

/**
 * A `since`/`until` bound as an ISO instant (`toISOString`, the form of a
 * node's `updatedAt`), or null when it is not a calendar date `YYYY-MM-DD`
 * or an ISO date-time: the filter then matches nothing. A bound without an
 * offset is UTC (never the server's time zone); a fraction is cut to
 * milliseconds.
 */
export function timeBound(value: string): string | null {
  const m = TIME_BOUND.exec(value)
  if (!m) return null
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', offset = 'Z'] = m
  const date = `${year}-${month}-${day}`
  // A bound names a real day: 2021-02-30 is refused, never rolled over to March.
  const midnight = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (midnight.getUTCFullYear() !== Number(year) || midnight.getUTCMonth() !== Number(month) - 1 || midnight.getUTCDate() !== Number(day)) return null
  const ms = Date.parse(`${date}T${hour}:${minute}:${second}${fraction.slice(0, 4)}${offset}`)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/**
 * `since`/`until` bound the resource's last change, `updatedAt` (#446, D9 on
 * #930): a note's `updated_at`, a code file's (the last sync that changed its
 * content), a symbol's file's. Frontmatter `timestamp` is the creation time
 * and plays no part. Compared at millisecond precision (a `Date` holds no
 * more), as search's SQL does (`date_trunc('milliseconds', updated_at)`).
 */
export function passesFilters(
  node: { type: string | null; tags: string[]; updatedAt: string | null },
  filters: GraphFilters,
): boolean {
  if (filters.types && (!node.type || !filters.types.includes(node.type))) return false
  if (filters.tags && !filters.tags.some((t) => node.tags.includes(t))) return false
  if (filters.since) {
    const since = timeBound(filters.since)
    if (since === null || node.updatedAt === null || node.updatedAt < since) return false
  }
  if (filters.until) {
    const until = timeBound(filters.until)
    if (until === null || node.updatedAt === null || node.updatedAt > until) return false
  }
  return true
}

/**
 * Puts `edges` in content order (#1006), given each node's place in node
 * order (`compareNodes`): an undirected edge names its earlier end as
 * `source`; edges sort by their earlier end, then their later end, kind,
 * relation and (a link or import both ways) source. Returns the undirected
 * projection Louvain and the community weights read, in that order: one
 * pair per unordered pair and kind (a link both ways counts once).
 */
function contentOrder(edges: GraphEdge[], rank: ReadonlyMap<string, number>): Array<readonly [string, string]> {
  const at = (id: string) => rank.get(id)!
  for (const e of edges) if (!e.directed && at(e.source) > at(e.target)) [e.source, e.target] = [e.target, e.source]
  const ends = (e: GraphEdge) => (at(e.source) < at(e.target) ? [e.source, e.target] : [e.target, e.source]) as [string, string]
  edges.sort((x, y) => {
    const [x0, x1] = ends(x)
    const [y0, y1] = ends(y)
    return at(x0) - at(y0) || at(x1) - at(y1) || compareCodeUnits(x.kind, y.kind) || compareCodeUnits(x.relation, y.relation) || at(x.source) - at(y.source)
  })
  const pairs: Array<readonly [string, string]> = []
  let last: GraphEdge | undefined
  for (const e of edges) {
    const [a, b] = ends(e)
    if (!last || a !== ends(last)[0] || b !== ends(last)[1] || e.kind !== last.kind) pairs.push([a, b])
    last = e
  }
  return pairs
}

/**
 * Collapses an assembled graph into one node per Louvain community. This
 * shrinks the payload and what the client has to draw; it does NOT make
 * buildGraph cheaper — the full assembly still runs (see issue #93). The
 * weights count `pairs` (`contentOrder`): a link both ways counts once.
 */
function collapseToCommunities(graph: VaultGraph, pairs: ReadonlyArray<readonly [string, string]>): CommunityGraph {
  const byCommunity = new Map<number, CommunityNode>()
  const communityOf = new Map<string, number>()

  for (const n of graph.nodes) {
    communityOf.set(n.id, n.community)
    let c = byCommunity.get(n.community)
    if (!c) {
      c = {
        id: `community:${n.community}`,
        community: n.community,
        size: 0,
        noteCount: 0,
        codeCount: 0,
        lastActivity: null,
      }
      byCommunity.set(n.community, c)
    }
    c.size += 1
    if (n.resourceType === 'code') c.codeCount += 1
    else c.noteCount += 1
    const ts = n.updatedAt ?? null
    if (ts && (c.lastActivity === null || ts > c.lastActivity)) c.lastActivity = ts
  }

  const weights = new Map<string, CommunityEdge>()
  for (const [source, target] of pairs) {
    const a = communityOf.get(source)
    const b = communityOf.get(target)
    if (a === undefined || b === undefined) continue
    if (a === b) continue // intra-community edges are already implied by size
    const [lo, hi] = a < b ? [a, b] : [b, a]
    const key = `${lo}|${hi}`
    const existing = weights.get(key)
    if (existing) existing.weight += 1
    else
      weights.set(key, { source: `community:${lo}`, target: `community:${hi}`, weight: 1 })
  }

  return {
    aggregated: true,
    nodes: [...byCommunity.values()].sort((x, y) => y.size - x.size || x.community - y.community),
    edges: [...weights.values()],
    cappedGroups: graph.cappedGroups,
  }
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
  filters?: Omit<GraphFilters, 'aggregate'> & { aggregate?: undefined },
): Promise<VaultGraph>
export async function buildGraph(
  resources: GraphResourceSet,
  filters: Omit<GraphFilters, 'aggregate'> & { aggregate: 'community' },
): Promise<CommunityGraph>
export async function buildGraph(
  resources: GraphResourceSet,
  filters?: GraphFilters,
): Promise<VaultGraph | CommunityGraph>
export async function buildGraph(
  resources: GraphResourceSet,
  filters: GraphFilters = {},
): Promise<VaultGraph | CommunityGraph> {
  const { vaultIds, repositoryIds } = resources
  if (vaultIds.length === 0 && repositoryIds.length === 0) {
    const empty: VaultGraph = { nodes: [], edges: [], cappedGroups: [] }
    return filters.aggregate === 'community' ? collapseToCommunities(empty, []) : empty
  }

  let internalNodes: InternalNode[] = []

  if (vaultIds.length > 0) {
    const noteRows = await db
      .select(NOTE_NODE_COLUMNS)
      .from(notes)
      .where(and(inArray(notes.vaultId, vaultIds), isNull(notes.deletedAt)))
    for (const r of noteRows) internalNodes.push(noteNode(r))
  }

  if (repositoryIds.length > 0) {
    const fileRows = await db
      .select(FILE_NODE_COLUMNS)
      .from(repositoryFiles)
      .where(inArray(repositoryFiles.repositoryId, repositoryIds))
    for (const r of fileRows) internalNodes.push(fileNode(r))
  }

  // Node order is content order (#1006): Louvain's partition depends on the
  // order it reads nodes and edges in, so no row order a query happens to
  // give (or an id order, which differs per database) may reach it.
  internalNodes = internalNodes.filter((n) => passesFilters(n, filters)).sort(compareNodes)
  const kinds = new Set(filters.edgeTypes ?? EDGE_KINDS)

  const byId = new Map(internalNodes.map((n) => [n.id, n]))
  const noteByVaultPath = new Map(
    internalNodes.filter((n) => n.resourceType === 'note').map((n) => [`${n.resourceId}:${n.path}`, n.id]),
  )
  const codeByRepoPath = new Map(
    internalNodes.filter((n) => n.resourceType === 'code').map((n) => [`${n.resourceId}:${n.path}`, n.id]),
  )
  const noteIds = internalNodes.filter((n) => n.resourceType === 'note').map((n) => n.id)
  const codeIds = internalNodes.filter((n) => n.resourceType === 'code').map((n) => n.id)

  const list = new EdgeList()
  const { edges } = list

  if (kinds.has('extracted') && noteIds.length > 0) {
    // EXTRACTED: plain wikilinks resolve within the source note's own
    // vault; a `repo:<name>/<path>` link resolves against a repository
    // already in this call's resource set (cross-type — spec 9).
    const repoNameToId = await repositoryNames(repositoryIds)
    const links = await db
      .select()
      .from(noteLinks)
      .where(inArray(noteLinks.sourceNoteId, noteIds))
    for (const link of links) {
      const source = byId.get(link.sourceNoteId)
      if (!source) continue
      const file = repoLinkTarget(link.targetPath, repoNameToId, repositoryIds)
      const targetId =
        file === undefined
          ? noteByVaultPath.get(`${source.resourceId}:${link.targetPath}`)
          : file && codeByRepoPath.get(`${file.repositoryId}:${file.path}`)
      if (targetId) list.add(linkEdge(link.sourceNoteId, targetId, link.startLine, link.endLine))
    }
  }

  if (kinds.has('extracted') && codeIds.length > 0) {
    // EXTRACTED: code imports resolved within the same repository.
    const imports = await db
      .select()
      .from(repositoryFileImports)
      .where(inArray(repositoryFileImports.sourceFileId, codeIds))
    for (const imp of imports) {
      if (imp.resolvedTargetFileId && byId.has(imp.resolvedTargetFileId)) {
        list.add(importEdge(imp.sourceFileId, imp.resolvedTargetFileId, imp.line))
      }
    }
  }

  if (kinds.has('semantic') && internalNodes.length > 0) {
    // Semantic: stored pairs (now spanning notes and code — spec 9)
    // filtered to the permitted, live node set.
    const allIds = [...byId.keys()]
    // ponytail: bind allIds as Postgres array literal to prevent 65,535 parameter ceiling crash on large repositories (DB-08).
    const pgIds = `{${allIds.join(',')}}`
    const sem = await db
      .select()
      .from(semanticEdges)
      .where(sql`${semanticEdges.sourceId} = ANY(${pgIds}::uuid[]) OR ${semanticEdges.targetId} = ANY(${pgIds}::uuid[])`)
    for (const edge of sem) {
      if (byId.has(edge.sourceId) && byId.has(edge.targetId)) {
        list.add(semanticEdge(edge.sourceId, edge.targetId, edge.similarity))
      }
    }
  }

  // Structural: pairs within each group (`groupKeys`).
  const cappedGroups: string[] = []
  if (kinds.has('structural')) {
    const groups = new Map<string, string[]>()
    for (const n of internalNodes) {
      for (const key of groupKeys(n)) {
        const members = groups.get(key)
        if (members) members.push(n.id)
        else groups.set(key, [n.id])
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
        for (let j = i + 1; j < ids.length; j++) list.add(structuralEdge(ids[i]!, ids[j]!, key))
      }
    }
  }

  // Louvain communities over the undirected projection of the assembled
  // edges, nodes and pairs in content order, seeded from the content.
  const pairs = contentOrder(edges, new Map(internalNodes.map((n, i) => [n.id, i])))
  const g = new UndirectedGraph()
  for (const n of internalNodes) g.addNode(n.id)
  for (const [a, b] of pairs) {
    if (!g.hasEdge(a, b)) g.addEdge(a, b)
  }
  const found: Record<string, number> =
    g.order > 0 && g.size > 0 ? louvain(g, { rng: mulberry32(seedFromKeys(internalNodes.map((n) => `${n.resourceType}:${n.path}`))) }) : {}
  // Communities numbered 0, 1, … in the node order of their first member (#1006), not by Louvain's own numbers.
  const numbers = new Map<number, number>()
  const nodes: GraphNode[] = internalNodes.map((n) => {
    const c = found[n.id]
    if (c !== undefined && !numbers.has(c)) numbers.set(c, numbers.size)
    return { ...n, community: c === undefined ? 0 : numbers.get(c)! }
  })

  const assembled: VaultGraph = { nodes, edges, cappedGroups }
  if (filters.aggregate === 'community') return collapseToCommunities(assembled, pairs)
  if (filters.community !== undefined) {
    const members = assembled.nodes.filter((n) => n.community === filters.community)
    const sliced = members
      .slice()
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || compareNodes(a, b))
      .slice(0, COMMUNITY_MEMBER_CAP)
    const ids = new Set(sliced.map((n) => n.id))
    return {
      nodes: sliced,
      edges: assembled.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      cappedGroups: assembled.cappedGroups,
      memberTotal: members.length,
    }
  }
  return assembled
}

export interface PathFindingResult {
  found: boolean
  nodes: GraphNode[]
  edges: GraphEdge[]
  distance: number
}

/**
 * Finds the shortest path connecting two nodes in a knowledge graph (BFS).
 * Traverses extracted wikilinks, structural hierarchy, and semantic edges.
 */
export function findShortestPath(
  graph: VaultGraph,
  sourceId: string,
  targetId: string,
): PathFindingResult {
  if (sourceId === targetId) {
    const node = graph.nodes.find((n) => n.id === sourceId)
    return node
      ? { found: true, nodes: [node], edges: [], distance: 0 }
      : { found: false, nodes: [], edges: [], distance: -1 }
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]))
  if (!nodeMap.has(sourceId) || !nodeMap.has(targetId)) {
    return { found: false, nodes: [], edges: [], distance: -1 }
  }

  const adj = new Map<string, Array<{ neighborId: string; edge: GraphEdge }>>()
  for (const edge of graph.edges) {
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

