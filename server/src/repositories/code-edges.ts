/**
 * Symbol-level code edges (#469, ADR-004 §2.8): the `code_edges` rows of a
 * repository file, from the sites extraction finds (code-edge-rules.ts), and
 * their resolution to a symbol block. #470's `references`, `callers`,
 * `impact` and `tests_for` and #534's repo map read them.
 *
 * Resolution order, for a site named `name` (`qualified` `Parent.name` when
 * the site names its parent; a `member` of a receiver of unknown type skips
 * the scope steps 1-3):
 * 1. a definition in the source file itself (code-edge-rules.ts, at
 *    extraction): `resolved`;
 * 2. a definition in the file the binding import's specifier (`via`)
 *    resolves to through the source file's `repository_file_imports` rows,
 *    or for C, C++, Ruby and PHP (whose includes and requires bring every
 *    name) in any file the source file imports: `resolved`;
 * 3. Go and Java: a definition in another file of the source file's
 *    directory and language (its package), unless an import binds the name: `resolved`;
 * 4. the one definition of that name in the repository (`qualified` first,
 *    then the bare name): `textual`, with the target;
 * 5. otherwise `textual` without a target: the name is defined nowhere, or
 *    several times (`symbolCandidates` lists them).
 * In steps 2 and 3 a plain name matches a module-level definition (its
 * `inner_path` is the name) and a qualified one the member it names; step 4
 * matches any definition. A step that finds definitions in several files,
 * or several definitions in one file under different inner paths, finds
 * none; overloads (one inner path) resolve to the first by line.
 *
 * Incremental: re-extracting a file replaces its rows (`replaceFileEdges`);
 * a file's change of definitions (added or removed symbol blocks, or the
 * file deleted) re-resolves the rows of the repository that can name them
 * (`reresolveAfterChange`), and an import row whose target changed (by
 * #1023's lookup keys after a sync, a manifest change or the boot backfill)
 * re-resolves its source file's rows (`reresolveFiles`). Steps 2-5 read only
 * blocks and import rows, so the table is the one a single push of the same
 * files builds whenever the import rows are. Every write takes the
 * repository's advisory lock (`lockRepositoryEdges`), so a sync deleting
 * files and the extraction worker never resolve against each other's
 * half-done state.
 */
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { chunks } from '../search/block-rows.js'
import { lineStarts, sliceLines } from '../text/lines.js'
import type { CodeBlock } from './code-blocks.js'
import type { ExtractedSite } from './code-edge-rules.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const CODE_EDGE_KINDS = ['call', 'reference', 'import', 'test'] as const
export type CodeEdgeKind = (typeof CODE_EDGE_KINDS)[number]

/** Rows one file may have; past it, test, then reference, then call rows go first (the file's note says how many). */
export const MAX_CODE_EDGES_PER_FILE = 5000
/** A row's context: its source line, trimmed, cut to this many code points. */
export const CONTEXT_CHARS = 160

/** A symbol block's bare name: its `inner_path` without the parent (the expression of `blocks_symbol_name_idx`). */
const SYMBOL_NAME = sql.raw(`(CASE WHEN b.symbol_parent IS NULL THEN b.inner_path ELSE substr(b.inner_path, length(b.symbol_parent) + 2) END)`)

/**
 * Test files by convention: `*.test.*`, `*.spec.*`, `*_test.go`,
 * `test_*.py`, `*_test.py`, and anything under `src/test/` (Maven, Gradle)
 * or `__tests__/`.
 */
const TEST_PATH = /(?:^|\/)(?:src\/test|__tests__)\/|\.(?:test|spec)\.[^./]+$|_test\.(?:go|py)$|(?:^|\/)test_[^/]*\.py$/

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

/** Languages whose package is their directory (step 3). */
const PACKAGE_SCOPED = new Set(['go', 'java'])
/** Languages whose includes and requires bring every name of the included file (step 2). */
const INCLUDES_ALL = new Set(['c', 'cpp', 'ruby', 'php'])

/** A row about to be written. */
export interface CodeEdgeDraft {
  kind: CodeEdgeKind
  line: number
  col: number
  name: string
  qualified: string | null
  via: string | null
  member: boolean
  context: string
  /** The enclosing symbol's block id. */
  sourceBlockId: string | null
  /** The block id of the source file's own symbol it resolves to (step 1). */
  local: string | null
}

const KIND_PRIORITY: Record<CodeEdgeKind, number> = { import: 0, call: 1, reference: 2, test: 3 }

/**
 * The rows of a file from its sites: `symbolBlocks` are its symbol blocks
 * (code-blocks.ts, one per extracted symbol, in the same order). A test file
 * adds one `test` row per name it calls or references that is not its own
 * definition, at its first site. Capped at `MAX_CODE_EDGES_PER_FILE`, with a
 * note saying what was dropped.
 */
export function codeEdgeDrafts(
  path: string,
  content: string,
  symbolBlocks: readonly Pick<CodeBlock, 'blockId'>[],
  sites: readonly ExtractedSite[],
): { drafts: CodeEdgeDraft[]; note: string | null } {
  const starts = lineStarts(content)
  const contexts = new Map<number, string>()
  const contextOf = (line: number) => {
    let context = contexts.get(line)
    if (context === undefined) {
      const text = sliceLines(content, line, line, starts).trim()
      context = text.length > CONTEXT_CHARS ? [...text].slice(0, CONTEXT_CHARS).join('') : text
      contexts.set(line, context)
    }
    return context
  }
  const blockOf = (index: number | null) => (index === null ? null : (symbolBlocks[index]?.blockId ?? null))
  const ordered = [...sites].sort((a, b) => a.line - b.line || a.col - b.col || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind])
  const all: CodeEdgeDraft[] = ordered.map((s) => ({
    kind: s.kind,
    line: s.line,
    col: s.col,
    name: s.name,
    qualified: s.qualified,
    via: s.via,
    member: s.member,
    context: contextOf(s.line),
    sourceBlockId: blockOf(s.enclosing),
    local: blockOf(s.local),
  }))
  if (isTestPath(path)) {
    const tested = new Set<string>()
    for (const d of all.slice()) {
      if (d.kind === 'import' || d.local !== null) continue
      const key = `${d.name}\u001f${d.qualified ?? ''}\u001f${d.via ?? ''}\u001f${d.member}`
      if (tested.has(key)) continue
      tested.add(key)
      all.push({ ...d, kind: 'test' })
    }
  }
  if (all.length <= MAX_CODE_EDGES_PER_FILE) return { drafts: all, note: null }
  const kept = [...all].sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]).slice(0, MAX_CODE_EDGES_PER_FILE)
  const dropped = new Map<CodeEdgeKind, number>()
  for (const d of all) dropped.set(d.kind, (dropped.get(d.kind) ?? 0) + 1)
  for (const d of kept) dropped.set(d.kind, dropped.get(d.kind)! - 1)
  const lost = CODE_EDGE_KINDS.flatMap((k) => (dropped.get(k) ? [`${dropped.get(k)} ${k}`] : []))
  return {
    drafts: kept,
    note: `code edges capped at ${MAX_CODE_EDGES_PER_FILE} per file: ${all.length} found, dropped ${lost.join(', ')}`,
  }
}

/** A text array parameter (any characters; the `{a,b}` literal form would need quoting). */
function textArray(values: Iterable<string>): SQL {
  return sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify([...values])}::jsonb))`
}
const uuidArray = (ids: Iterable<string>): SQL => sql`${`{${[...ids].join(',')}}`}::uuid[]`

/** Serialises every code edge write of a repository, until the transaction ends. */
export async function lockRepositoryEdges(tx: Tx, repositoryId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`code_edges:${repositoryId}`}, 0))`)
}

/** A symbol definition: its block, keyed `inner_path` + block id, with its bare name. */
export interface Definition {
  innerPath: string
  name: string
}
export type Definitions = Map<string, Definition>

const definitionKey = (innerPath: string, blockId: string) => `${innerPath}\u001f${blockId}`

/** The symbol definitions of these files' stored blocks. */
export async function storedDefinitions(tx: Tx, fileIds: readonly string[]): Promise<Definitions> {
  const out: Definitions = new Map()
  if (fileIds.length === 0) return out
  const rows = (await tx.execute(sql`
    SELECT b.inner_path AS "innerPath", b.block_id AS "blockId", ${SYMBOL_NAME} AS name
    FROM blocks b WHERE b.owner_type = 'code' AND b.owner_id = ANY(${uuidArray(fileIds)}) AND b.kind = 'symbol'`)) as unknown as Array<{
    innerPath: string
    blockId: string
    name: string
  }>
  for (const r of rows) out.set(definitionKey(r.innerPath, r.blockId), { innerPath: r.innerPath, name: r.name })
  return out
}

/** The symbol definitions of a block set about to be written. */
export function blockDefinitions(rows: ReadonlyArray<{ kind: string; blockId: string; innerPath: string; symbolParent: string | null }>): Definitions {
  const out: Definitions = new Map()
  for (const b of rows) {
    if (b.kind !== 'symbol') continue
    out.set(definitionKey(b.innerPath, b.blockId), { innerPath: b.innerPath, name: b.symbolParent === null ? b.innerPath : b.innerPath.slice(b.symbolParent.length + 1) })
  }
  return out
}

/** Definitions one side has and the other has not. */
export function changedDefinitions(before: Definitions, after: Definitions): Definition[] {
  const out: Definition[] = []
  for (const [key, d] of before) if (!after.has(key)) out.push(d)
  for (const [key, d] of after) if (!before.has(key)) out.push(d)
  return out
}

/**
 * Files whose rows can resolve into these files through scope: the files
 * importing them (step 2), and for Go and Java the other files of their
 * directory and language (step 3).
 */
export async function nearFiles(tx: Tx, repositoryId: string, fileIds: readonly string[]): Promise<string[]> {
  if (fileIds.length === 0) return []
  const ids = uuidArray(fileIds)
  const rows = (await tx.execute(sql`
    SELECT i.source_file_id AS id FROM repository_file_imports i WHERE i.resolved_target_file_id = ANY(${ids})
    UNION
    SELECT g.id FROM repository_files f
    JOIN repository_files g ON g.repository_id = f.repository_id AND g.language = f.language
      AND regexp_replace(g.path, '/?[^/]*$', '') = regexp_replace(f.path, '/?[^/]*$', '')
    WHERE f.id = ANY(${ids}) AND f.repository_id = ${repositoryId} AND f.language = ANY(${textArray(PACKAGE_SCOPED)})`)) as unknown as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/** A row to resolve, as stored or as drafted. */
interface EdgeKey {
  sourceFileId: string
  sourcePath: string
  sourceLanguage: string | null
  name: string
  qualified: string | null
  via: string | null
  member: boolean
}
interface Target {
  targetFileId: string | null
  targetBlockId: string | null
  confidence: 'resolved' | 'textual'
}
interface Candidate {
  ownerId: string
  blockId: string
  innerPath: string
  name: string
  path: string
  language: string | null
  /** Definitions of `name` in the repository, one per file and inner path. */
  byName: number
  /** Files defining `inner_path`. */
  byPath: number
}

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))

/**
 * Resolves rows by steps 2-5 against the stored blocks and import rows
 * (inside `tx`, so a file's own new blocks and imports count), in three
 * queries whatever the number of rows.
 */
async function resolveKeys(tx: Tx, repositoryId: string, keys: readonly EdgeKey[]): Promise<Target[]> {
  if (keys.length === 0) return []
  const sources = [...new Set(keys.map((k) => k.sourceFileId))]
  const importRows = (await tx.execute(sql`
    SELECT source_file_id AS "sourceFileId", target_path AS "targetPath", resolved_target_file_id AS "targetFileId"
    FROM repository_file_imports
    WHERE source_file_id = ANY(${uuidArray(sources)}) AND resolved_target_file_id IS NOT NULL`)) as unknown as Array<{
    sourceFileId: string
    targetPath: string
    targetFileId: string
  }>
  const imports = new Map<string, Map<string, string>>()
  for (const r of importRows) {
    let bySpecifier = imports.get(r.sourceFileId)
    if (!bySpecifier) imports.set(r.sourceFileId, (bySpecifier = new Map()))
    bySpecifier.set(r.targetPath, r.targetFileId)
  }
  const dirs = new Set(keys.filter((k) => k.sourceLanguage !== null && PACKAGE_SCOPED.has(k.sourceLanguage)).map((k) => dirOf(k.sourcePath)))
  const candidateRows = (await tx.execute(sql`
    WITH c AS (
      SELECT b.owner_id, b.block_id, b.inner_path, ${SYMBOL_NAME} AS name, b.start_line, f.path, f.language
      FROM blocks b JOIN repository_files f ON f.id = b.owner_id
      WHERE b.owner_type = 'code' AND b.container_id = ${repositoryId} AND b.kind = 'symbol'
        AND ${SYMBOL_NAME} = ANY(${textArray(new Set(keys.map((k) => k.name)))})
    ),
    by_name AS (SELECT name, count(DISTINCT (owner_id, inner_path))::int AS n FROM c GROUP BY name),
    by_path AS (SELECT inner_path, count(DISTINCT owner_id)::int AS n FROM c GROUP BY inner_path)
    SELECT c.owner_id AS "ownerId", c.block_id AS "blockId", c.inner_path AS "innerPath", c.name, c.path, c.language,
      by_name.n AS "byName", by_path.n AS "byPath"
    FROM c JOIN by_name USING (name) JOIN by_path USING (inner_path)
    WHERE by_name.n = 1 OR by_path.n = 1
      OR c.owner_id = ANY(${uuidArray(new Set(importRows.map((r) => r.targetFileId)))})
      OR regexp_replace(c.path, '/?[^/]*$', '') = ANY(${textArray(dirs)})
    ORDER BY c.owner_id, c.inner_path, c.start_line, c.block_id`)) as unknown as Candidate[]
  const byName = new Map<string, Candidate[]>()
  for (const c of candidateRows) {
    const list = byName.get(c.name)
    if (list) list.push(c)
    else byName.set(c.name, [c])
  }

  /** The first definition when all are one file's and one inner path's (overloads), else none. */
  const single = (found: Candidate[]): Candidate | null =>
    found.length > 0 && found.every((c) => c.ownerId === found[0]!.ownerId && c.innerPath === found[0]!.innerPath) ? found[0]! : null
  const none: Target = { targetFileId: null, targetBlockId: null, confidence: 'textual' }

  return keys.map((k) => {
    const named = byName.get(k.name) ?? []
    // Steps 2 and 3 never name the source file itself (step 1 did, at extraction).
    const scoped = (c: Candidate) => c.ownerId !== k.sourceFileId && c.innerPath === (k.qualified ?? k.name)
    let found: Candidate | null = null
    if (!k.member) {
      const fileImports = imports.get(k.sourceFileId)
      const files = k.via !== null ? [fileImports?.get(k.via)] : k.sourceLanguage !== null && INCLUDES_ALL.has(k.sourceLanguage) ? [...(fileImports?.values() ?? [])] : []
      if (files.some(Boolean)) found = single(named.filter((c) => files.includes(c.ownerId) && scoped(c)))
      if (!found && k.via === null && k.sourceLanguage !== null && PACKAGE_SCOPED.has(k.sourceLanguage)) {
        const dir = dirOf(k.sourcePath)
        found = single(named.filter((c) => c.language === k.sourceLanguage && dirOf(c.path) === dir && scoped(c)))
      }
    }
    if (found) return { targetFileId: found.ownerId, targetBlockId: found.blockId, confidence: 'resolved' }
    const unique =
      (k.qualified !== null ? named.find((c) => c.innerPath === k.qualified && c.byPath === 1) : undefined) ?? named.find((c) => c.byName === 1)
    return unique ? { targetFileId: unique.ownerId, targetBlockId: unique.blockId, confidence: 'textual' } : none
  })
}

/**
 * Replaces a file's rows with `drafts`, resolved: step 1 from extraction,
 * the others against the blocks and import rows `tx` already holds for it.
 */
export async function replaceFileEdges(
  tx: Tx,
  file: { id: string; repositoryId: string; path: string; language: string | null },
  drafts: readonly CodeEdgeDraft[],
): Promise<void> {
  await tx.execute(sql`DELETE FROM code_edges WHERE source_file_id = ${file.id}`)
  if (drafts.length === 0) return
  const open = drafts.filter((d) => d.local === null)
  const targets = await resolveKeys(
    tx,
    file.repositoryId,
    open.map((d) => ({ sourceFileId: file.id, sourcePath: file.path, sourceLanguage: file.language, name: d.name, qualified: d.qualified, via: d.via, member: d.member })),
  )
  const resolved = new Map(open.map((d, i) => [d, targets[i]!]))
  const rows = drafts.map((d) => {
    const t = resolved.get(d) ?? { targetFileId: file.id, targetBlockId: d.local, confidence: 'resolved' }
    return {
      line: d.line,
      col: d.col,
      kind: d.kind,
      source_block_id: d.sourceBlockId,
      target_name: d.name,
      target_qualified: d.qualified,
      via: d.via,
      member: d.member,
      target_file_id: t.targetFileId,
      target_block_id: t.targetBlockId,
      confidence: t.confidence,
      context: d.context,
    }
  })
  for (const chunk of chunks(rows)) {
    await tx.execute(sql`
      INSERT INTO code_edges (source_file_id, repository_id, line, col, kind, source_block_id, target_name, target_qualified, via, member,
        target_file_id, target_block_id, confidence, context)
      SELECT ${file.id}, ${file.repositoryId}, r.line, r.col, r.kind, r.source_block_id, r.target_name, r.target_qualified, r.via, r.member,
        r.target_file_id, r.target_block_id, r.confidence, r.context
      FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS r(line int, col int, kind text, source_block_id text, target_name text,
        target_qualified text, via text, member boolean, target_file_id uuid, target_block_id text, confidence text, context text)
      ON CONFLICT DO NOTHING`)
  }
}

/** Resolves again the stored rows `scope` selects (steps 2-5; rows resolved in their own file stay) and writes those that changed. */
async function reresolve(tx: Tx, repositoryId: string, scope: SQL): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT e.source_file_id AS "sourceFileId", e.line, e.col, e.kind, sf.path AS "sourcePath", sf.language AS "sourceLanguage",
      e.target_name AS name, e.target_qualified AS qualified, e.via, e.member,
      e.target_file_id AS "targetFileId", e.target_block_id AS "targetBlockId", e.confidence
    FROM code_edges e JOIN repository_files sf ON sf.id = e.source_file_id
    WHERE e.repository_id = ${repositoryId}
      AND NOT (e.confidence = 'resolved' AND e.target_file_id = e.source_file_id)
      AND (${scope})`)) as unknown as Array<EdgeKey & Target & { line: number; col: number; kind: string }>
  const targets = await resolveKeys(tx, repositoryId, rows)
  const changed = rows.flatMap((r, i) => {
    const t = targets[i]!
    return t.targetFileId === r.targetFileId && t.targetBlockId === r.targetBlockId && t.confidence === r.confidence
      ? []
      : [{ source: r.sourceFileId, line: r.line, col: r.col, kind: r.kind, file: t.targetFileId, block: t.targetBlockId, confidence: t.confidence }]
  })
  for (const chunk of chunks(changed)) {
    await tx.execute(sql`
      UPDATE code_edges e SET target_file_id = u.file, target_block_id = u.block, confidence = u.confidence
      FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS u(source uuid, line int, col int, kind text, file uuid, block text, confidence text)
      WHERE e.source_file_id = u.source AND e.line = u.line AND e.col = u.col AND e.kind = u.kind`)
  }
  return changed.length
}

/**
 * After `files` gained or lost the definitions `changed` (re-extracted, or
 * deleted), re-resolves the rows of the repository whose answer can move:
 * those naming one of them that point into these files or whose source is
 * `near` them (`nearFiles`: steps 2 and 3), and the `textual` ones naming a
 * name with at most one definition outside these files (step 4). A row
 * resolved through its imports or package into another file keeps its
 * answer: neither its import rows nor that file changed.
 */
export async function reresolveAfterChange(
  tx: Tx,
  repositoryId: string,
  files: readonly string[],
  changed: readonly Definition[],
  near: readonly string[],
): Promise<number> {
  if (changed.length === 0) return 0
  const names = new Set(changed.map((d) => d.name))
  const qualified = new Set(changed.filter((d) => d.innerPath !== d.name).map((d) => d.innerPath))
  const others = (await tx.execute(sql`
    SELECT ${SYMBOL_NAME} AS name, NULL AS "innerPath", count(DISTINCT (b.owner_id, b.inner_path))::int AS n
    FROM blocks b
    WHERE b.owner_type = 'code' AND b.container_id = ${repositoryId} AND b.kind = 'symbol'
      AND ${SYMBOL_NAME} = ANY(${textArray(names)}) AND b.owner_id <> ALL(${uuidArray(files)})
    GROUP BY 1
    UNION ALL
    SELECT NULL, b.inner_path, count(DISTINCT b.owner_id)::int
    FROM blocks b
    WHERE b.owner_type = 'code' AND b.container_id = ${repositoryId} AND b.kind = 'symbol'
      AND ${SYMBOL_NAME} = ANY(${textArray(names)}) AND b.inner_path = ANY(${textArray(qualified)}) AND b.owner_id <> ALL(${uuidArray(files)})
    GROUP BY 2`)) as unknown as Array<{ name: string | null; innerPath: string | null; n: number }>
  const defined = new Map(others.flatMap((r) => (r.name !== null ? [[r.name, r.n] as const] : [])))
  const definedPath = new Map(others.flatMap((r) => (r.innerPath !== null ? [[r.innerPath, r.n] as const] : [])))
  const rare = [...names].filter((n) => (defined.get(n) ?? 0) <= 1)
  const rareQualified = changed.filter((d) => qualified.has(d.innerPath) && (definedPath.get(d.innerPath) ?? 0) <= 1)
  const terms: SQL[] = [
    sql`(e.target_name = ANY(${textArray(names)}) AND (e.target_file_id = ANY(${uuidArray(files)}) OR e.source_file_id = ANY(${uuidArray(near)})))`,
  ]
  if (rare.length > 0) terms.push(sql`(e.confidence = 'textual' AND e.target_name = ANY(${textArray(rare)}))`)
  if (rareQualified.length > 0) {
    terms.push(sql`(e.confidence = 'textual' AND e.target_name = ANY(${textArray(rareQualified.map((d) => d.name))})
      AND e.target_qualified = ANY(${textArray(rareQualified.map((d) => d.innerPath))}))`)
  }
  return reresolve(tx, repositoryId, sql.join(terms, sql` OR `))
}

/** Re-resolves every row of these source files (their import rows changed). */
export async function reresolveFiles(tx: Tx, repositoryId: string, fileIds: readonly string[]): Promise<number> {
  return fileIds.length === 0 ? 0 : reresolve(tx, repositoryId, sql`e.source_file_id = ANY(${uuidArray(fileIds)})`)
}

// ---------------------------------------------------------------- reads

/** A code edge as #470 shows it: `path:line`, the enclosing symbol, one line of context, the confidence and the target. */
export interface CodeEdgeRow {
  path: string
  line: number
  col: number
  kind: CodeEdgeKind
  /** The enclosing symbol (`Class.method`), null at module level. */
  symbol: string | null
  name: string
  qualified: string | null
  confidence: 'resolved' | 'textual'
  /** The target symbol, when one was found. */
  target: { path: string; symbol: string; line: number } | null
  context: string
}

/** A repository's code edges from one file, or to one name, in path and line order. */
export async function listCodeEdges(repositoryId: string, filter: { path?: string; name?: string }): Promise<CodeEdgeRow[]> {
  const rows = (await db.execute(sql`
    SELECT sf.path, e.line, e.col, e.kind, sb.inner_path AS symbol, e.target_name AS name, e.target_qualified AS qualified, e.confidence,
      tf.path AS "targetPath", tb.inner_path AS "targetSymbol", tb.start_line AS "targetLine", e.context
    FROM code_edges e
    JOIN repository_files sf ON sf.id = e.source_file_id
    LEFT JOIN blocks sb ON sb.owner_type = 'code' AND sb.owner_id = e.source_file_id AND sb.block_id = e.source_block_id
    LEFT JOIN repository_files tf ON tf.id = e.target_file_id
    LEFT JOIN blocks tb ON tb.owner_type = 'code' AND tb.owner_id = e.target_file_id AND tb.block_id = e.target_block_id
    WHERE e.repository_id = ${repositoryId}
      ${filter.path !== undefined ? sql`AND sf.path = ${filter.path}` : sql``}
      ${filter.name !== undefined ? sql`AND e.target_name = ${filter.name}` : sql``}
    ORDER BY sf.path COLLATE "C", e.line, e.col, e.kind`)) as unknown as Array<
    Omit<CodeEdgeRow, 'target'> & { targetPath: string | null; targetSymbol: string | null; targetLine: number | null }
  >
  return rows.map(({ targetPath, targetSymbol, targetLine, ...r }) => ({
    ...r,
    target: targetPath !== null && targetSymbol !== null && targetLine !== null ? { path: targetPath, symbol: targetSymbol, line: targetLine } : null,
  }))
}

/** The definitions a name has in a repository (an ambiguous name's candidates), in path and line order. */
export async function symbolCandidates(repositoryId: string, name: string): Promise<Array<{ path: string; symbol: string; kind: string; line: number }>> {
  return (await db.execute(sql`
    SELECT f.path, b.inner_path AS symbol, b.symbol_kind AS kind, b.start_line AS line
    FROM blocks b JOIN repository_files f ON f.id = b.owner_id
    WHERE b.owner_type = 'code' AND b.container_id = ${repositoryId} AND b.kind = 'symbol' AND ${SYMBOL_NAME} = ${name}
    ORDER BY f.path COLLATE "C", b.start_line, b.block_id`)) as unknown as Array<{ path: string; symbol: string; kind: string; line: number }>
}
