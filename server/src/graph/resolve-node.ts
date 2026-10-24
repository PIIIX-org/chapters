import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, repositoryFiles } from '../db/schema.js'
import { editDistance } from '../mcp/strict-input.js'
import { compareCodeUnits } from '../mcp/response.js'
import { FILE_NODE_COLUMNS, NOTE_NODE_COLUMNS, fileNode, noteNode, type GraphResourceSet, type InternalNode } from './assemble.js'

/**
 * The graph node a reference names (#447): what `graph`'s `neighborsOf`,
 * `find_graph_path`'s ends and the REST path routes take. Tried in order,
 * the first tier with a match wins:
 *
 * 1. the node id;
 * 2. the exact path (a note path without `.md`, a repository file path);
 * 3. the path in any case, a note path with `.md`, a file path without its
 *    extension (`server/src/notes/store`);
 * 4. a path suffix on a `/` boundary, in any case, with or without a file's
 *    extension (`store.ts`, `notes/store.ts`, `notes/store`): a basename is
 *    the one-segment suffix;
 * 5. a note's frontmatter `title`, in any case.
 *
 * Graph nodes are notes and files, not symbols, so a symbol name is not a
 * tier. One node resolves; several are candidates, shorter path first,
 * then path (code-unit order) and id, the first MAX_CANDIDATES shown with
 * the total; none gives up to MAX_SUGGESTIONS nearby paths (none for a
 * node id). Every query reads only `resources` (live notes of its vaults,
 * files of its repositories), the set the graph is built from and which the
 * caller's access resolved: a candidate or suggestion is always in its
 * reach, and an id out of reach answers as a missing one.
 */

export const MAX_CANDIDATES = 10
const MAX_SUGGESTIONS = 5
/** Paths read per table as the pool suggestions are ranked from. */
const SUGGESTION_POOL = 200

export interface NodeCandidate {
  path: string
  kind: InternalNode['resourceType']
  id: string
}

export type NodeResolution =
  | { node: InternalNode }
  /** `next`: the candidate after the shown ones, if any (a limit + 1 read); `total`: how many matched. */
  | { candidates: NodeCandidate[]; next: NodeCandidate | null; total: number }
  | { suggestions: string[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A file path without its last segment's extension; a dotfile keeps its name. */
const stripExtension = (path: string) => path.replace(/([^/])\.[^./]*$/, '$1')
const STRIP_EXTENSION_SQL = (column: SQL) => sql`regexp_replace(${column}, '([^/])\\.[^./]*$', '\\1')`
const text = (value: string) => sql`${value}::text`
const anyOf = (parts: SQL[]) => sql`(${sql.join(parts, sql` OR `)})`
/** `column` ends with `/` + `suffix`, both lowercased. */
const endsWithSegment = (column: SQL, suffix: string) => sql`right(${column}, length(lower(${text(suffix)})) + 1) = '/' || lower(${text(suffix)})`

const byRank = (a: NodeCandidate, b: NodeCandidate) =>
  [...a.path].length - [...b.path].length || compareCodeUnits(a.path, b.path) || compareCodeUnits(a.id, b.id)
const candidate = (n: InternalNode): NodeCandidate => ({ path: n.path, kind: n.resourceType, id: n.id })

/** The nodes in `resources` whose id (tier 1) or path (tier 2) is `ref`. */
async function exact(resources: GraphResourceSet, by: 'id' | 'path', ref: string): Promise<InternalNode[]> {
  const found: InternalNode[] = []
  if (resources.vaultIds.length > 0) {
    const rows = await db
      .select(NOTE_NODE_COLUMNS)
      .from(notes)
      .where(and(inArray(notes.vaultId, resources.vaultIds), isNull(notes.deletedAt), eq(by === 'id' ? notes.id : notes.path, ref)))
    found.push(...rows.map(noteNode))
  }
  if (resources.repositoryIds.length > 0) {
    const rows = await db
      .select(FILE_NODE_COLUMNS)
      .from(repositoryFiles)
      .where(and(inArray(repositoryFiles.repositoryId, resources.repositoryIds), eq(by === 'id' ? repositoryFiles.id : repositoryFiles.path, ref)))
    found.push(...rows.map(fileNode))
  }
  return found
}

interface TierRow {
  node: InternalNode
  tier: number
  /** The rows of its tier in its table. */
  total: number
}

/**
 * Tiers 3 to 5: one query per table, the tier as a CASE, the rows of each
 * tier counted with a window; the first MAX_CANDIDATES + 1 rows by tier,
 * then the candidates' order.
 */
async function lenient(resources: GraphResourceSet, ref: string): Promise<TierRow[]> {
  const rows: TierRow[] = []
  // A note path is stored without `.md`; `Concepts/Alpha.md` names `concepts/alpha`.
  const notePaths = /\.md$/i.test(ref) ? [ref, ref.slice(0, -3)] : [ref]
  if (resources.vaultIds.length > 0) {
    const path = sql`lower(${notes.path})`
    const tier = sql<number>`CASE
      WHEN ${anyOf(notePaths.map((p) => sql`${path} = lower(${text(p)})`))} THEN 3
      WHEN ${anyOf(notePaths.map((p) => endsWithSegment(path, p)))} THEN 4
      WHEN lower(${notes.frontmatter}->>'title') = lower(${text(ref)}) THEN 5
    END`
    const found = await db
      .select({ ...NOTE_NODE_COLUMNS, tier: tier.mapWith(Number), total: sql<number>`count(*) over (partition by ${tier})`.mapWith(Number) })
      .from(notes)
      .where(and(inArray(notes.vaultId, resources.vaultIds), isNull(notes.deletedAt), sql`${tier} IS NOT NULL`))
      .orderBy(tier, sql`length(${notes.path})`, sql`${notes.path} collate "C"`, notes.id)
      .limit(MAX_CANDIDATES + 1)
    rows.push(...found.map((r) => ({ node: noteNode(r), tier: r.tier, total: r.total })))
  }
  if (resources.repositoryIds.length > 0) {
    const path = sql`lower(${repositoryFiles.path})`
    const bare = sql`lower(${STRIP_EXTENSION_SQL(sql`${repositoryFiles.path}`)})`
    const tier = sql<number>`CASE
      WHEN ${path} = lower(${text(ref)}) OR ${bare} = lower(${text(ref)}) THEN 3
      WHEN ${endsWithSegment(path, ref)} OR ${endsWithSegment(bare, ref)} THEN 4
    END`
    const found = await db
      .select({ ...FILE_NODE_COLUMNS, tier: tier.mapWith(Number), total: sql<number>`count(*) over (partition by ${tier})`.mapWith(Number) })
      .from(repositoryFiles)
      .where(and(inArray(repositoryFiles.repositoryId, resources.repositoryIds), sql`${tier} IS NOT NULL`))
      .orderBy(tier, sql`length(${repositoryFiles.path})`, sql`${repositoryFiles.path} collate "C"`, repositoryFiles.id)
      .limit(MAX_CANDIDATES + 1)
    rows.push(...found.map((r) => ({ node: fileNode(r), tier: r.tier, total: r.total })))
  }
  return rows
}

/**
 * Up to MAX_SUGGESTIONS paths near `ref`, for a reference that matched
 * nothing. The pool, at most SUGGESTION_POOL paths per table: the same
 * basename (without extension) in any folder, then paths in a folder ending
 * like `ref`'s, then basenames containing `ref`'s or sharing its first two
 * characters. Each is ranked by the edit distance between `ref` and the
 * path's last as many segments (with and without extension, in any case);
 * the same basename is always kept, others within a quarter of `ref`'s
 * length (at least 1).
 */
async function nearby(resources: GraphResourceSet, ref: string): Promise<string[]> {
  const wanted = ref.toLowerCase()
  const slash = wanted.lastIndexOf('/')
  const folder = slash === -1 ? '' : wanted.slice(0, slash)
  const base = stripExtension(wanted.slice(slash + 1))
  if (base === '') return []
  // The pool's conditions on a path column, and the order they rank in.
  const pool = (column: SQL, stripName: boolean) => {
    const name = sql`regexp_replace(${column}, '^.*/', '')`
    const lname = sql`lower(${stripName ? STRIP_EXTENSION_SQL(name) : name})`
    const dir = sql`lower(CASE WHEN strpos(${column}, '/') > 0 THEN regexp_replace(${column}, '/[^/]*$', '') ELSE '' END)`
    const near = [sql`${lname} = ${text(base)}`]
    if (folder !== '') near.push(sql`(${dir} = ${text(folder)} OR ${endsWithSegment(dir, folder)})`)
    if (base.length >= 3) near.push(sql`strpos(${lname}, ${text(base)}) > 0`)
    if (base.length >= 2) near.push(sql`left(${lname}, 2) = ${text(base.slice(0, 2))}`)
    const priority = sql`CASE ${sql.join(near.map((when, i) => sql`WHEN ${when} THEN ${sql.raw(String(i))}`), sql` `)} END`
    return { where: anyOf(near), orderBy: [priority, sql`length(${column})`, sql`${column} collate "C"`] }
  }
  const reads: Array<Promise<Array<{ path: string }>>> = []
  if (resources.vaultIds.length > 0) {
    const near = pool(sql`${notes.path}`, false)
    reads.push(
      db
        .select({ path: notes.path })
        .from(notes)
        .where(and(inArray(notes.vaultId, resources.vaultIds), isNull(notes.deletedAt), near.where))
        .orderBy(...near.orderBy)
        .limit(SUGGESTION_POOL),
    )
  }
  if (resources.repositoryIds.length > 0) {
    const near = pool(sql`${repositoryFiles.path}`, true)
    reads.push(
      db
        .select({ path: repositoryFiles.path })
        .from(repositoryFiles)
        .where(and(inArray(repositoryFiles.repositoryId, resources.repositoryIds), near.where))
        .orderBy(...near.orderBy)
        .limit(SUGGESTION_POOL),
    )
  }
  const paths = new Set((await Promise.all(reads)).flat().map((r) => r.path))
  const segments = wanted.split('/').length
  const forms = [...new Set([wanted, stripExtension(wanted)])]
  const limit = Math.max(1, Math.floor(wanted.length / 4))
  const ranked: Array<{ path: string; distance: number }> = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    const tail = lower.split('/').slice(-segments).join('/')
    const distance = Math.min(...[tail, stripExtension(tail)].flatMap((t) => forms.map((f) => editDistance(f, t))))
    const sameName = stripExtension(lower.slice(lower.lastIndexOf('/') + 1)) === base
    if (sameName || distance <= limit) ranked.push({ path, distance })
  }
  ranked.sort((a, b) => a.distance - b.distance || [...a.path].length - [...b.path].length || compareCodeUnits(a.path, b.path))
  return ranked.slice(0, MAX_SUGGESTIONS).map((r) => r.path)
}

/** The node `ref` names in `resources`, its candidates, or suggestions (see the module comment). */
export async function resolveNode(resources: GraphResourceSet, ref: string): Promise<NodeResolution> {
  const found: InternalNode[] = UUID.test(ref) ? await exact(resources, 'id', ref) : []
  if (found.length === 0) found.push(...(await exact(resources, 'path', ref)))
  if (found.length === 1) return { node: found[0]! }
  if (found.length > 1) {
    // A note and a file with one path (or one path in two vaults).
    const ranked = found.map(candidate).sort(byRank)
    return { candidates: ranked.slice(0, MAX_CANDIDATES), next: ranked[MAX_CANDIDATES] ?? null, total: ranked.length }
  }
  // An id names one node or none: no partial match, and no suggestions, so an
  // id out of reach answers as a missing one.
  const wanted = ref.trim().replace(/^\.?\/+/, '')
  if (wanted === '' || UUID.test(ref)) return { suggestions: [] }
  const rows = await lenient(resources, wanted)
  if (rows.length === 0) return { suggestions: await nearby(resources, wanted) }
  const best = Math.min(...rows.map((r) => r.tier))
  const tierRows = rows.filter((r) => r.tier === best)
  // Each table counted its rows of this tier.
  let total = 0
  for (const kind of ['note', 'code'] as const) total += tierRows.find((r) => r.node.resourceType === kind)?.total ?? 0
  if (total === 1) return { node: tierRows[0]!.node }
  const ranked = tierRows.map((r) => candidate(r.node)).sort(byRank)
  return { candidates: ranked.slice(0, MAX_CANDIDATES), next: ranked[MAX_CANDIDATES] ?? null, total }
}
