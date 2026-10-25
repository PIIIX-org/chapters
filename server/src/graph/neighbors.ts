import { and, eq, inArray, isNotNull, isNull, like, ne, or, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client.js'
import { noteLinks, notes, repositoryFileImports, repositoryFiles, semanticEdges } from '../db/schema.js'
import { location } from '../mcp/response.js'
import { bodyStartLine } from '../notes/projector.js'
import {
  EDGE_KINDS,
  EdgeList,
  FILE_NODE_COLUMNS,
  NOTE_NODE_COLUMNS,
  STRUCTURAL_GROUP_CAP,
  compareNodes,
  fileNode,
  groupKeys,
  importEdge,
  linkEdge,
  noteNode,
  passesFilters,
  repoLinkTarget,
  repositoryNames,
  semanticEdge,
  structuralEdge,
  type EdgeKind,
  type GraphEdge,
  type GraphResourceSet,
  type InternalNode,
} from './assemble.js'

/**
 * The local graph around one node (#426): every node within `depth` edges of
 * it and every edge among them, the nodes and edges `buildGraph` gives for the
 * same resources and filters, restricted to that neighbourhood. It is read
 * ring by ring in SQL over the frontier's ids only; the rest of the graph is
 * never assembled, and there is no Louvain pass (communities need the whole
 * graph), so nodes carry their `distance` instead. `backlinksOf` lists the
 * links to a note centre one per line, with their context (#472).
 */

export interface LocalNode extends InternalNode {
  distance: number
}

export interface LocalGraph {
  /** Nearest first: by distance, then node order (`compareNodes`: path, then kind); the centre first. */
  nodes: LocalNode[]
  edges: GraphEdge[]
  /** Structural groups over the cap that a listed node belongs to, skipped as in `buildGraph`. */
  cappedGroups: string[]
  /** The nearest node past `limit` (null: none, or no limit): a caller can say that more exist. */
  next: LocalNode | null
}

export interface NeighborhoodOptions {
  /** Edges from the centre, at least 1. */
  depth: number
  edgeTypes?: readonly EdgeKind[]
  /** As `buildGraph`'s filters: they keep the nodes around the centre; the centre itself is always shown. */
  types?: string[]
  tags?: string[]
  /** The nearest `limit` nodes and the edges among them; the walk stops at the ring that reaches limit + 1. */
  limit?: number
}

/** Ids bound as one Postgres array literal: a ring can hold more ids than a query has parameters (as `buildGraph`'s semantic query). */
const anyId = (column: AnyColumn, ids: readonly string[]) => sql`${column} = ANY(${`{${ids.join(',')}}`}::uuid[])`

/** A code file's top-level directory in SQL, as `topDirectory`. */
const TOP_DIRECTORY = sql`CASE WHEN strpos(${repositoryFiles.path}, '/') > 0 THEN split_part(${repositoryFiles.path}, '/', 1) ELSE '.' END`

/** The nodes reached so far, by id and by path. */
class Reach {
  readonly byId = new Map<string, InternalNode>()
  private readonly byPath = new Map<string, string>()

  add(n: InternalNode): void {
    this.byId.set(n.id, n)
    this.byPath.set(`${n.resourceType}:${n.resourceId}:${n.path}`, n.id)
  }

  idAt(resourceType: 'note' | 'code', resourceId: string, path: string): string | undefined {
    return this.byPath.get(`${resourceType}:${resourceId}:${path}`)
  }
}

interface Walk {
  resources: GraphResourceSet
  repoNameToId: ReadonlyMap<string, string>
  kinds: ReadonlySet<EdgeKind>
  filters: { types?: string[]; tags?: string[] }
  reach: Reach
  cappedGroups: Set<string>
}

/** `filters` as SQL on notes (`passesFilters`, without the time range). */
function noteFilterSql(filters: Walk['filters']): SQL[] {
  const clauses: SQL[] = []
  if (filters.types) clauses.push(inArray(notes.type, filters.types))
  if (filters.tags) {
    const tags = sql.join(filters.tags.map((t) => sql`${t}`), sql`, `)
    clauses.push(sql`jsonb_typeof(${notes.frontmatter}->'tags') = 'array' AND ${notes.frontmatter}->'tags' ?| array[${tags}]::text[]`)
  }
  return clauses
}

/** `filters` as SQL on repository files: a type is a language, and code has no tags. */
function fileFilterSql(filters: Walk['filters']): SQL[] {
  const clauses: SQL[] = []
  if (filters.types) clauses.push(inArray(repositoryFiles.language, filters.types))
  if (filters.tags) clauses.push(sql`false`)
  return clauses
}

/** An edge a ring found from a frontier node, and its other end. */
interface Found {
  far: string
  edge: GraphEdge
}

/**
 * One ring: every edge with an end in `frontier`, in its own direction.
 * Other ends not reached yet are read and added to the reach when they pass
 * the filters; with `within`, none is added and only edges inside `within`
 * are kept (the last round, for the edges among the kept nodes).
 */
async function ring(walk: Walk, frontier: InternalNode[], within: ReadonlySet<string> | null): Promise<Found[]> {
  const { resources, reach, kinds, filters } = walk
  const { vaultIds, repositoryIds } = resources
  const inFrontier = new Set(frontier.map((n) => n.id))
  const noteIds = frontier.filter((n) => n.resourceType === 'note').map((n) => n.id)
  const codeIds = frontier.filter((n) => n.resourceType === 'code').map((n) => n.id)
  // Other ends named by id: [frontier node, other end, edge].
  const byId: Array<[string, string, GraphEdge]> = []
  // Links out to an end named by path: [frontier note, its type, its container, its path, start line, end line].
  const byPath: Array<[string, 'note' | 'code', string, string, number, number]> = []
  // Other ends read whole: [frontier node, the other end, edge].
  const rows: Array<[string, InternalNode, GraphEdge]> = []

  if (kinds.has('extracted') && noteIds.length > 0) {
    // A frontier note's links: to a note of its vault, or to a file of a repository in the call (`repo:` links).
    const links = await db
      .select({ source: noteLinks.sourceNoteId, target: noteLinks.targetPath, startLine: noteLinks.startLine, endLine: noteLinks.endLine })
      .from(noteLinks)
      .where(anyId(noteLinks.sourceNoteId, noteIds))
    for (const link of links) {
      const file = repoLinkTarget(link.target, walk.repoNameToId, repositoryIds)
      if (file === undefined) byPath.push([link.source, 'note', reach.byId.get(link.source)!.resourceId, link.target, link.startLine, link.endLine])
      else if (file) byPath.push([link.source, 'code', file.repositoryId, file.path, link.startLine, link.endLine])
    }
    // Links to a frontier note from a live note of its vault.
    const target = alias(notes, 'target')
    const backlinks = await db
      .select({ ...NOTE_NODE_COLUMNS, to: target.id, startLine: noteLinks.startLine, endLine: noteLinks.endLine })
      .from(noteLinks)
      .innerJoin(target, eq(target.path, noteLinks.targetPath))
      .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
      .where(and(anyId(target.id, noteIds), eq(notes.vaultId, target.vaultId), isNull(notes.deletedAt)))
    for (const { to, startLine, endLine, ...source } of backlinks) rows.push([to, noteNode(source), linkEdge(source.id, to, startLine, endLine)])
  }

  if (kinds.has('extracted') && codeIds.length > 0) {
    if (vaultIds.length > 0) {
      // `repo:`/`code:` links to a frontier file, resolved as `buildGraph` resolves them.
      const repoLinks = await db
        .select({ ...NOTE_NODE_COLUMNS, target: noteLinks.targetPath, startLine: noteLinks.startLine, endLine: noteLinks.endLine })
        .from(noteLinks)
        .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
        .where(and(inArray(notes.vaultId, vaultIds), isNull(notes.deletedAt), or(like(noteLinks.targetPath, 'repo:%'), like(noteLinks.targetPath, 'code:%'))))
      for (const { target: link, startLine, endLine, ...source } of repoLinks) {
        const file = repoLinkTarget(link, walk.repoNameToId, repositoryIds)
        const to = file ? reach.idAt('code', file.repositoryId, file.path) : undefined
        if (to && inFrontier.has(to)) rows.push([to, noteNode(source), linkEdge(source.id, to, startLine, endLine)])
      }
    }
    // Resolved imports both ways (within one repository).
    const imports = await db
      .select({ source: repositoryFileImports.sourceFileId, target: repositoryFileImports.resolvedTargetFileId, line: repositoryFileImports.line })
      .from(repositoryFileImports)
      .where(and(anyId(repositoryFileImports.sourceFileId, codeIds), isNotNull(repositoryFileImports.resolvedTargetFileId)))
    for (const imp of imports) byId.push([imp.source, imp.target!, importEdge(imp.source, imp.target!, imp.line)])
    const importers = await db
      .select({ ...FILE_NODE_COLUMNS, to: repositoryFileImports.resolvedTargetFileId, line: repositoryFileImports.line })
      .from(repositoryFileImports)
      .innerJoin(repositoryFiles, eq(repositoryFiles.id, repositoryFileImports.sourceFileId))
      .where(and(anyId(repositoryFileImports.resolvedTargetFileId, codeIds), inArray(repositoryFiles.repositoryId, repositoryIds)))
    for (const { to, line, ...source } of importers) rows.push([to!, fileNode(source), importEdge(source.id, to!, line)])
  }

  if (kinds.has('semantic')) {
    const ids = [...inFrontier]
    const sem = await db
      .select({ source: semanticEdges.sourceId, target: semanticEdges.targetId, similarity: semanticEdges.similarity })
      .from(semanticEdges)
      .where(or(anyId(semanticEdges.sourceId, ids), anyId(semanticEdges.targetId, ids)))
    for (const s of sem) {
      if (inFrontier.has(s.source)) byId.push([s.source, s.target, semanticEdge(s.source, s.target, s.similarity)])
      if (inFrontier.has(s.target)) byId.push([s.target, s.source, semanticEdge(s.source, s.target, s.similarity)])
    }
  }

  const groups = kinds.has('structural') ? await groupMembers(walk, frontier) : new Map<string, InternalNode[]>()

  // Read the other ends named by id or path that are not reached yet.
  if (within === null) {
    const accept = (n: InternalNode) => {
      if (!reach.byId.has(n.id) && passesFilters(n, filters)) reach.add(n)
    }
    for (const [, n] of rows) accept(n)
    for (const members of groups.values()) for (const n of members) accept(n)
    const ids = [...new Set(byId.map(([, id]) => id).filter((id) => !reach.byId.has(id)))]
    if (ids.length > 0 && vaultIds.length > 0) {
      const found = await db.select(NOTE_NODE_COLUMNS).from(notes).where(and(anyId(notes.id, ids), inArray(notes.vaultId, vaultIds), isNull(notes.deletedAt)))
      for (const r of found) accept(noteNode(r))
    }
    if (ids.length > 0 && repositoryIds.length > 0) {
      const found = await db
        .select(FILE_NODE_COLUMNS)
        .from(repositoryFiles)
        .where(and(anyId(repositoryFiles.id, ids), inArray(repositoryFiles.repositoryId, repositoryIds)))
      for (const r of found) accept(fileNode(r))
    }
    const notePaths = [...new Set(byPath.filter(([, t, r, p]) => t === 'note' && !reach.idAt(t, r, p)).map(([, , , p]) => p))]
    if (notePaths.length > 0 && vaultIds.length > 0) {
      const found = await db.select(NOTE_NODE_COLUMNS).from(notes).where(and(inArray(notes.vaultId, vaultIds), isNull(notes.deletedAt), inArray(notes.path, notePaths)))
      for (const r of found) accept(noteNode(r))
    }
    const filePaths = [...new Set(byPath.filter(([, t, r, p]) => t === 'code' && !reach.idAt(t, r, p)).map(([, , , p]) => p))]
    if (filePaths.length > 0 && repositoryIds.length > 0) {
      const found = await db
        .select(FILE_NODE_COLUMNS)
        .from(repositoryFiles)
        .where(and(inArray(repositoryFiles.repositoryId, repositoryIds), inArray(repositoryFiles.path, filePaths)))
      for (const r of found) accept(fileNode(r))
    }
  }

  const found: Found[] = []
  const keep = (near: string, far: string | undefined, edge: (far: string) => GraphEdge) => {
    if (far === undefined || far === near || !reach.byId.has(far)) return
    if (within && !within.has(far)) return
    found.push({ far, edge: edge(far) })
  }
  for (const [near, far, edge] of byId) keep(near, far, () => edge)
  for (const [near, type, resourceId, path, startLine, endLine] of byPath) keep(near, reach.idAt(type, resourceId, path), (far) => linkEdge(near, far, startLine, endLine))
  for (const [near, n, edge] of rows) keep(near, n.id, () => edge)
  for (const n of frontier) {
    for (const key of groupKeys(n)) {
      for (const member of groups.get(key) ?? []) keep(n.id, member.id, (far) => structuralEdge(n.id, far, key))
    }
  }
  return found
}

/**
 * The members of the frontier's structural groups (`groupKeys`) within the
 * resources and filters, by group key. A group over `STRUCTURAL_GROUP_CAP`
 * is counted in SQL, not read, and reported in `cappedGroups`.
 */
async function groupMembers(walk: Walk, frontier: InternalNode[]): Promise<Map<string, InternalNode[]>> {
  const { vaultIds, repositoryIds } = walk.resources
  const keys = new Set(frontier.flatMap(groupKeys))
  const sizes = new Map<string, number>()
  const types = [...keys].filter((k) => k.startsWith('type:')).map((k) => k.slice('type:'.length))
  const tags = [...keys].filter((k) => k.startsWith('tag:')).map((k) => k.slice('tag:'.length))
  const languages = [...keys].filter((k) => k.startsWith('language:')).map((k) => k.slice('language:'.length))
  const dirs = [...keys].filter((k) => k.startsWith('dir:')).map((k) => k.slice('dir:'.length))
  const liveNotes = and(inArray(notes.vaultId, vaultIds), isNull(notes.deletedAt), ...noteFilterSql(walk.filters))
  const files = and(inArray(repositoryFiles.repositoryId, repositoryIds), ...fileFilterSql(walk.filters))
  const hasTag = (tag: string) => sql`(jsonb_typeof(${notes.frontmatter}->'tags') = 'array' AND ${notes.frontmatter}->'tags' ? ${tag})`
  const dirKey = sql<string>`${repositoryFiles.repositoryId}::text || ':' || ${TOP_DIRECTORY}`

  if (vaultIds.length > 0 && types.length > 0) {
    const counts = await db
      .select({ type: notes.type, n: sql<number>`count(*)::int` })
      .from(notes)
      .where(and(liveNotes, inArray(notes.type, types)))
      .groupBy(notes.type)
    for (const c of counts) sizes.set(`type:${c.type}`, c.n)
  }
  if (vaultIds.length > 0 && tags.length > 0) {
    const [counts] = await db
      .select(Object.fromEntries(tags.map((tag, i) => [`t${i}`, sql<number>`(count(*) FILTER (WHERE ${hasTag(tag)}))::int`])))
      .from(notes)
      .where(and(liveNotes, or(...tags.map(hasTag))))
    tags.forEach((tag, i) => sizes.set(`tag:${tag}`, counts?.[`t${i}`] ?? 0))
  }
  if (repositoryIds.length > 0 && languages.length > 0) {
    const counts = await db
      .select({ language: repositoryFiles.language, n: sql<number>`count(*)::int` })
      .from(repositoryFiles)
      .where(and(files, inArray(repositoryFiles.language, languages)))
      .groupBy(repositoryFiles.language)
    for (const c of counts) sizes.set(`language:${c.language}`, c.n)
  }
  if (repositoryIds.length > 0 && dirs.length > 0) {
    const counts = await db
      .select({ key: dirKey, n: sql<number>`count(*)::int` })
      .from(repositoryFiles)
      .where(and(files, inArray(dirKey, dirs)))
      .groupBy(dirKey)
    for (const c of counts) sizes.set(`dir:${c.key}`, c.n)
  }

  const open = (k: string) => {
    const size = sizes.get(k) ?? 0
    if (size > STRUCTURAL_GROUP_CAP) walk.cappedGroups.add(k)
    return size > 0 && size <= STRUCTURAL_GROUP_CAP
  }
  const openTypes = types.filter((t) => open(`type:${t}`))
  const openTags = tags.filter((t) => open(`tag:${t}`))
  const openLanguages = languages.filter((l) => open(`language:${l}`))
  const openDirs = dirs.filter((d) => open(`dir:${d}`))
  const members: InternalNode[] = []
  if (openTypes.length > 0 || openTags.length > 0) {
    const found = await db
      .select(NOTE_NODE_COLUMNS)
      .from(notes)
      .where(and(liveNotes, or(...(openTypes.length > 0 ? [inArray(notes.type, openTypes)] : []), ...openTags.map(hasTag))))
    members.push(...found.map(noteNode))
  }
  if (openLanguages.length > 0 || openDirs.length > 0) {
    const found = await db
      .select(FILE_NODE_COLUMNS)
      .from(repositoryFiles)
      .where(and(files, or(...(openLanguages.length > 0 ? [inArray(repositoryFiles.language, openLanguages)] : []), ...(openDirs.length > 0 ? [inArray(dirKey, openDirs)] : []))))
    members.push(...found.map(fileNode))
  }
  const openKeys = new Set([...openTypes.map((t) => `type:${t}`), ...openTags.map((t) => `tag:${t}`), ...openLanguages.map((l) => `language:${l}`), ...openDirs.map((d) => `dir:${d}`)])
  const byKey = new Map<string, InternalNode[]>()
  for (const m of members) {
    for (const key of groupKeys(m)) {
      if (!openKeys.has(key)) continue
      const list = byKey.get(key)
      if (list) list.push(m)
      else byKey.set(key, [m])
    }
  }
  return byKey
}

const byNearest = (a: LocalNode, b: LocalNode) => a.distance - b.distance || compareNodes(a, b)

/** The local graph around `center` (see the module comment). */
export async function neighborhood(resources: GraphResourceSet, center: InternalNode, options: NeighborhoodOptions): Promise<LocalGraph> {
  const walk: Walk = {
    resources,
    repoNameToId: await repositoryNames(resources.repositoryIds),
    kinds: new Set(options.edgeTypes ?? EDGE_KINDS),
    filters: { types: options.types, tags: options.tags },
    reach: new Reach(),
    cappedGroups: new Set(),
  }
  walk.reach.add(center)
  const distance = new Map([[center.id, 0]])
  const edges = new EdgeList()
  const expanded = new Set<string>()
  let frontier = [center]
  for (let d = 1; d <= options.depth && frontier.length > 0; d++) {
    // The nearest limit + 1 are known: every further node ranks after them.
    if (options.limit !== undefined && distance.size > options.limit) break
    const found = await ring(walk, frontier, null)
    for (const n of frontier) expanded.add(n.id)
    const next: InternalNode[] = []
    for (const { far, edge } of found) {
      edges.add(edge)
      if (!distance.has(far)) {
        distance.set(far, d)
        next.push(walk.reach.byId.get(far)!)
      }
    }
    frontier = next
  }

  const ranked = [...distance].map(([id, d]) => ({ ...walk.reach.byId.get(id)!, distance: d })).sort(byNearest)
  const nodes = options.limit === undefined ? ranked : ranked.slice(0, options.limit)
  const kept = new Set(nodes.map((n) => n.id))
  // The edges among kept nodes the walk did not expand (the outer ring).
  const outer = nodes.filter((n) => !expanded.has(n.id))
  if (outer.length > 0) {
    for (const { edge } of await ring(walk, outer, kept)) edges.add(edge)
  }
  return {
    nodes,
    edges: edges.edges.filter((e) => kept.has(e.source) && kept.has(e.target)),
    cappedGroups: [...walk.cappedGroups].sort(),
    next: ranked[nodes.length] ?? null,
  }
}

/** A link to a note (#472): the linking note, where the link is (`path#La`, lines of its `.md` file) and its paragraph or line. */
export interface Backlink {
  path: string
  /** The linking note's path alone for a row not located yet (written before migration 0031). */
  location: string
  /** Null for a row the boot catch-up has not filled yet (written before migration 0039). */
  context: string | null
}

/** The most backlinks an answer lists: one more is read, so the answer can say that more exist. */
export const BACKLINK_CAP = 1_000

/**
 * Every stored link to note `center` from another live note of its vault,
 * resolved as graph link edges are (the exact path), one per row (a target
 * linked on several lines has several), by path in code-unit order, then
 * line; at most `BACKLINK_CAP` + 1. Stored lines are body-relative
 * (ADR-004 §2.2): each linking note's frontmatter turns them into lines of
 * its file. `filters` keep the linking notes, as they keep the nodes around
 * the centre.
 */
export async function backlinksOf(center: InternalNode, filters: Walk['filters']): Promise<Backlink[]> {
  const rows = await db
    .select({
      path: notes.path,
      frontmatter: notes.frontmatter,
      frontmatterSrc: sql<unknown>`frontmatter_src`,
      startLine: noteLinks.startLine,
      endLine: noteLinks.endLine,
      context: noteLinks.context,
    })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .where(and(eq(noteLinks.targetPath, center.path), eq(notes.vaultId, center.resourceId), isNull(notes.deletedAt), ne(notes.id, center.id), ...noteFilterSql(filters)))
    .orderBy(sql`${notes.path} COLLATE "C"`, noteLinks.startLine)
    .limit(BACKLINK_CAP + 1)
  const bodyStart = new Map<string, number>()
  return rows.map((r) => {
    if (r.startLine === 0) return { path: r.path, location: r.path, context: r.context }
    let start = bodyStart.get(r.path)
    if (start === undefined) bodyStart.set(r.path, (start = bodyStartLine(r)))
    return { path: r.path, location: location(r.path, r.startLine + start - 1, r.endLine + start - 1), context: r.context }
  })
}
