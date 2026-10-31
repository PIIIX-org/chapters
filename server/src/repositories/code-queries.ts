/**
 * The questions #470 asks of `code_edges` (#469) and `blocks`, one function
 * each, shared by the MCP tool (`find_symbols` with `refs`) and the REST
 * routes (routes.ts): which symbol is at a file line (`symbolAt`), which
 * definitions a name has (`findDefinitions`: several are an ambiguity the
 * caller shows as candidates, never a guess), the sites that name a
 * definition (`codeSites`: references, callers, tests) and what depends on it
 * transitively (`impact`). A site is `path:line`, the enclosing symbol, one
 * line of context, the kind of edge (why the row exists) and its
 * confidence: `resolved` (found through the file's scope, imports or
 * package) or `textual` (matched by name only; tree-sitter, not a compiler).
 *
 * Callers pass a repository the account may read; nothing here checks access.
 *
 * Which edges name a definition `D` (file `F`, blocks `B`, name `N`, inner
 * path `P`): the rows whose target is one of `B` (`resolved`, or `textual`
 * when matched by name alone), and the rows with no target whose name is `N`
 * and whose qualifier, when they name one, is `P` (an ambiguous name's
 * sites: `textual`). Rows that resolution step 4 gave a repository-unique
 * target for a name its own file imports from outside the repository
 * (`import { parse } from 'yaml'`: a `textual` row with an import specifier
 * that resolves to no file, in a TypeScript or JavaScript file) are left
 * out: 2 of 10 hand-checked such rows were right (#1046 review), where the
 * `textual` rows of Python and Go, whose module specifiers never resolve,
 * were 8 of 10 and 8 of 8. Order: `resolved` before `textual`, then path
 * (code units), line, column, kind, a total order, so the same index always
 * answers the same bytes.
 *
 * `impact` follows the `call` and `reference` rows from `D` outwards, one
 * level per hop of symbols: level 1 holds the sites that name `D`, level
 * `n + 1` the sites that name a symbol one of whose sites is on level `n`,
 * each symbol on the first (shortest) level that reaches it. Only rows with
 * a target continue past level 1 (a name-only match of a common name would
 * fan out to every definition of it). A row is `resolved` only when every hop
 * on its way is. A site at module level ends its chain.
 */
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { textArray } from '../search/block-rows.js'
import { SYMBOL_NAME, type CodeEdgeKind } from './code-edges.js'

/** Levels `impact` follows at most. */
export const MAX_IMPACT_DEPTH = 3
/** Rows `impact` reads per level; more are counted (`capped`), not listed. */
export const IMPACT_LEVEL_ROWS = 500
/** Symbols a level hands on to the next. */
export const IMPACT_FRONTIER = 200
/** Definitions of one name listed as candidates (as the graph's `MAX_CANDIDATES`). */
export const MAX_DEFINITIONS = 10
/** Definition rows read for one name (a definition is one or more rows: overloads). */
const DEFINITION_ROWS = 1_000
/** Languages whose imports resolve to files and whose unresolved ones are outside the repository (see the header). */
const EXTERNAL_SPECIFIER_LANGUAGES = ['typescript', 'javascript']

/** What a question names: a symbol of the repository, or only a name nothing in it defines. */
export interface Target {
  fileId: string | null
  /** The `block_id`s of the definition: overloads are several blocks of one inner path. */
  blockIds: string[]
  /** The bare name, as `code_edges.target_name`. */
  name: string
  /** The inner path (`Class.method`). */
  symbol: string
}

/** A symbol definition. */
export interface Definition extends Target {
  /** `blocks.id`, the `id` `find_symbols` lists. */
  id: string
  fileId: string
  path: string
  kind: string
  parent: string | null
  line: number
  endLine: number
}

export interface DefinitionRef {
  /** A name (`parse`) or an inner path (`Store.save`). */
  name?: string
  /** A symbol's `blocks.id` (what `find_symbols` lists) or its `block_id` (`b_...`). */
  id?: string
  /** Only definitions in this file. */
  path?: string
  kind?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BLOCK_ID = /^b_[a-z2-7]{12}$/

/** Whether `text` is a symbol id (`blocks.id`, or a `block_id`) rather than a name. */
export const isSymbolId = (text: string): boolean => UUID.test(text) || BLOCK_ID.test(text)

/**
 * The definitions a reference names, in path, inner path and line order,
 * overloads (one file, one inner path) as one definition whose `id` is the
 * first by line. More than one is an ambiguity.
 */
export async function findDefinitions(repositoryId: string, ref: DefinitionRef): Promise<Definition[]> {
  let match: SQL
  if (ref.id !== undefined) {
    match = UUID.test(ref.id) ? sql`b.id = ${ref.id}` : BLOCK_ID.test(ref.id) ? sql`b.block_id = ${ref.id}` : sql`false`
  } else if (ref.name !== undefined) {
    // The index serves the bare name; a name with a dot is an inner path or a dotted name (`namespace A.B`).
    const bare = ref.name.slice(ref.name.lastIndexOf('.') + 1)
    match = sql`${SYMBOL_NAME} IN (${bare}, ${ref.name}) AND (${SYMBOL_NAME} = ${ref.name} OR b.inner_path = ${ref.name})`
  } else {
    return []
  }
  const rows = (await db.execute(sql`
    SELECT b.id, b.owner_id AS "fileId", b.block_id AS "blockId", f.path, b.inner_path AS symbol, ${SYMBOL_NAME} AS name,
      b.symbol_kind AS kind, b.symbol_parent AS parent, b.start_line AS line, b.end_line AS "endLine"
    FROM blocks b JOIN repository_files f ON f.id = b.owner_id
    WHERE b.owner_type = 'code' AND b.container_id = ${repositoryId} AND b.kind = 'symbol' AND ${match}
      ${ref.path !== undefined ? sql`AND f.path = ${ref.path}` : sql``}
      ${ref.kind !== undefined ? sql`AND b.symbol_kind = ${ref.kind}` : sql``}
    ORDER BY f.path COLLATE "C", b.inner_path COLLATE "C", b.start_line, b.block_id
    LIMIT ${DEFINITION_ROWS}`)) as unknown as Array<Omit<Definition, 'blockIds'> & { blockId: string }>
  const definitions: Definition[] = []
  for (const { blockId, ...row } of rows) {
    const last = definitions[definitions.length - 1]
    if (last && last.fileId === row.fileId && last.symbol === row.symbol) last.blockIds.push(blockId)
    else definitions.push({ ...row, blockIds: [blockId] })
  }
  return definitions
}

/** A site: an edge row as #470 shows it. */
export interface CodeSite {
  path: string
  line: number
  col: number
  /** Why the row exists: the kind of edge. */
  kind: CodeEdgeKind
  /** The enclosing symbol (`Class.method`); null at module level. */
  symbol: string | null
  confidence: 'resolved' | 'textual'
  /** The source line, trimmed. */
  context: string
}

/** The edge kinds each question reads. */
export const SITE_KINDS = {
  references: ['call', 'reference', 'import'],
  callers: ['call'],
  tests: ['test'],
  /** What `impact` follows. */
  dependents: ['call', 'reference'],
} as const satisfies Record<string, readonly CodeEdgeKind[]>

const SITE_COLUMNS = sql`sf.path, e.line, e.col, e.kind, e.confidence, e.context, sb.inner_path AS symbol`
const SITE_JOINS = sql`
  JOIN repository_files sf ON sf.id = e.source_file_id
  LEFT JOIN blocks sb ON sb.owner_type = 'code' AND sb.owner_id = e.source_file_id AND sb.block_id = e.source_block_id`
const SITE_ORDER = sql`ORDER BY (e.confidence = 'resolved') DESC, sf.path COLLATE "C", e.line, e.col, e.kind`

/** Rows with a textual target by repository-unique fallback for a name the source file imports from outside the repository. */
const NOT_EXTERNAL = sql`NOT (e.confidence = 'textual' AND e.via IS NOT NULL AND sf.language = ANY(${textArray(EXTERNAL_SPECIFIER_LANGUAGES)})
  AND NOT EXISTS (SELECT 1 FROM repository_file_imports i WHERE i.source_file_id = e.source_file_id AND i.target_path = e.via AND i.resolved_target_file_id IS NOT NULL))`

/** The rows that name `target`: those resolved to it, and the target-less ones of its name. */
const naming = (target: Target): SQL => sql`(
  ${target.fileId !== null ? sql`(e.target_file_id = ${target.fileId} AND e.target_block_id = ANY(${textArray(target.blockIds)})) OR` : sql``}
  (e.target_file_id IS NULL AND e.target_name = ${target.name} AND (e.target_qualified IS NULL OR e.target_qualified = ${target.symbol})))`

/** One page of the sites of `kind` that name `target`, `limit` rows from `offset`. */
export async function codeSites(
  repositoryId: string,
  target: Target,
  kinds: readonly CodeEdgeKind[],
  page: { limit: number; offset: number },
): Promise<CodeSite[]> {
  return (await db.execute(sql`
    SELECT ${SITE_COLUMNS}
    FROM code_edges e ${SITE_JOINS}
    WHERE e.repository_id = ${repositoryId} AND e.kind = ANY(${textArray(kinds)}) AND ${naming(target)} AND ${NOT_EXTERNAL}
    ${SITE_ORDER}
    LIMIT ${page.limit} OFFSET ${page.offset}`)) as unknown as CodeSite[]
}

/** The symbol at a line of a file, and the edges that start on that line. */
export interface SymbolAt {
  /** The innermost symbol block around the line: null between symbols. */
  symbol: Definition | null
  sites: Array<Pick<CodeSite, 'kind' | 'confidence'> & { name: string; target: { path: string; symbol: string; line: number } | null }>
  /** More sites on the line than `limit`. */
  more: boolean
}

/** null when the repository has no such file. */
export async function symbolAt(repositoryId: string, path: string, line: number, page: { limit: number; offset: number }): Promise<SymbolAt | null> {
  const [file] = (await db.execute(sql`
    SELECT id FROM repository_files WHERE repository_id = ${repositoryId} AND path = ${path}`)) as unknown as Array<{ id: string }>
  if (!file) return null
  const [symbol] = (await db.execute(sql`
    SELECT b.id, b.owner_id AS "fileId", ARRAY[b.block_id] AS "blockIds", ${path}::text AS path, b.inner_path AS symbol, ${SYMBOL_NAME} AS name,
      b.symbol_kind AS kind, b.symbol_parent AS parent, b.start_line AS line, b.end_line AS "endLine"
    FROM blocks b
    WHERE b.owner_type = 'code' AND b.owner_id = ${file.id} AND b.kind = 'symbol' AND b.start_line <= ${line} AND b.end_line >= ${line}
    ORDER BY b.end_line - b.start_line, b.start_line DESC, b.block_id
    LIMIT 1`)) as unknown as Definition[]
  const sites = (await db.execute(sql`
    SELECT e.kind, e.confidence, e.target_name AS name, tf.path AS "targetPath", tb.inner_path AS "targetSymbol", tb.start_line AS "targetLine"
    FROM code_edges e
    LEFT JOIN repository_files tf ON tf.id = e.target_file_id
    LEFT JOIN blocks tb ON tb.owner_type = 'code' AND tb.owner_id = e.target_file_id AND tb.block_id = e.target_block_id
    WHERE e.source_file_id = ${file.id} AND e.line = ${line}
    ORDER BY e.col, e.kind
    LIMIT ${page.limit + 1} OFFSET ${page.offset}`)) as unknown as Array<{
    kind: CodeEdgeKind
    confidence: 'resolved' | 'textual'
    name: string
    targetPath: string | null
    targetSymbol: string | null
    targetLine: number | null
  }>
  return {
    symbol: symbol ?? null,
    sites: sites.slice(0, page.limit).map(({ targetPath, targetSymbol, targetLine, ...site }) => ({
      ...site,
      target: targetPath !== null && targetSymbol !== null && targetLine !== null ? { path: targetPath, symbol: targetSymbol, line: targetLine } : null,
    })),
    more: sites.length > page.limit,
  }
}

/** A site of `impact`: past level 1, the symbol it names (`path#Class.method`) as `to`. */
export interface ImpactSite extends CodeSite {
  to?: string
}

export interface ImpactLevel {
  /** The sites of this level, in order. */
  sites: ImpactSite[]
  /** How many there are: `IMPACT_LEVEL_ROWS` and `capped` when more were found. */
  total: number
  capped: boolean
}

interface Reached {
  path: string
  symbol: string
  /** `resolved` when some site on a chain of resolved rows reaches the symbol. */
  confidence: 'resolved' | 'textual'
}

/**
 * What depends on `target`, `depth` (at most `MAX_IMPACT_DEPTH`) levels out;
 * a level that finds nothing ends it (fewer levels come back).
 */
export async function impact(repositoryId: string, target: Target, depth: number): Promise<ImpactLevel[]> {
  const levels: ImpactLevel[] = []
  const visited = new Set<string>(target.fileId !== null ? target.blockIds.map((b) => `${target.fileId}\0${b}`) : [])
  /** The symbols the next level looks for sites of, by `fileId\0blockId`. */
  let frontier = new Map<string, Reached>()
  for (let level = 1; level <= Math.min(depth, MAX_IMPACT_DEPTH); level++) {
    let rows: Array<CodeSite & { sourceFileId: string; sourceBlockId: string | null; targetFileId: string | null; targetBlockId: string | null }>
    if (level === 1) {
      rows = (await db.execute(sql`
        SELECT ${SITE_COLUMNS}, e.source_file_id AS "sourceFileId", e.source_block_id AS "sourceBlockId", e.target_file_id AS "targetFileId", e.target_block_id AS "targetBlockId"
        FROM code_edges e ${SITE_JOINS}
        WHERE e.repository_id = ${repositoryId} AND e.kind = ANY(${textArray(SITE_KINDS.dependents)}) AND ${naming(target)} AND ${NOT_EXTERNAL}
        ${SITE_ORDER}
        LIMIT ${IMPACT_LEVEL_ROWS + 1}`)) as unknown as typeof rows
    } else {
      const wanted = JSON.stringify([...frontier.keys()].map((k) => k.split('\0')).map(([f, b]) => ({ f, b })))
      const seen = JSON.stringify([...visited].map((k) => k.split('\0')).map(([f, b]) => ({ f, b })))
      rows = (await db.execute(sql`
        SELECT ${SITE_COLUMNS}, e.source_file_id AS "sourceFileId", e.source_block_id AS "sourceBlockId", e.target_file_id AS "targetFileId", e.target_block_id AS "targetBlockId"
        FROM code_edges e ${SITE_JOINS}
        WHERE e.repository_id = ${repositoryId} AND e.kind = ANY(${textArray(SITE_KINDS.dependents)}) AND ${NOT_EXTERNAL}
          AND (e.target_file_id, e.target_block_id) IN (SELECT w.f, w.b FROM jsonb_to_recordset(${wanted}::jsonb) AS w(f uuid, b text))
          AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${seen}::jsonb) AS v(f uuid, b text) WHERE v.f = e.source_file_id AND v.b = e.source_block_id)
        ${SITE_ORDER}
        LIMIT ${IMPACT_LEVEL_ROWS + 1}`)) as unknown as typeof rows
    }
    const capped = rows.length > IMPACT_LEVEL_ROWS
    if (capped) rows = rows.slice(0, IMPACT_LEVEL_ROWS)
    if (rows.length === 0) break

    const next = new Map<string, Reached>()
    const sites: ImpactSite[] = rows.map(({ sourceFileId, sourceBlockId, targetFileId, targetBlockId, ...site }) => {
      const via = level === 1 ? undefined : frontier.get(`${targetFileId}\0${targetBlockId}`)
      // A chain is as sure as its least sure hop.
      const confidence = site.confidence === 'resolved' && (via === undefined || via.confidence === 'resolved') ? 'resolved' : 'textual'
      if (sourceBlockId !== null && site.symbol !== null) {
        const key = `${sourceFileId}\0${sourceBlockId}`
        const known = next.get(key)
        if (!known) next.set(key, { path: site.path, symbol: site.symbol, confidence })
        else if (confidence === 'resolved') known.confidence = 'resolved'
      }
      return { ...site, confidence, ...(via ? { to: `${via.path}#${via.symbol}` } : {}) }
    })
    sites.sort(
      (a, b) =>
        Number(b.confidence === 'resolved') - Number(a.confidence === 'resolved') ||
        compare(a.path, b.path) ||
        a.line - b.line ||
        a.col - b.col ||
        compare(a.kind, b.kind),
    )
    levels.push({ sites, total: rows.length, capped })

    frontier = new Map()
    for (const [key, reached] of next) {
      // Every symbol listed here is on its shortest level, also one past the frontier.
      visited.add(key)
      if (frontier.size < IMPACT_FRONTIER) frontier.set(key, reached)
    }
  }
  return levels
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
