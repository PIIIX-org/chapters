/**
 * The maps `orient` (#534) answers with, one level at a time.
 *
 * Repository: the definitions under a folder ranked by how much of the
 * repository uses them, and the folders one level below it, ranked the same
 * way. A definition's `refs` are the `resolved` call, reference and import
 * rows of `code_edges` (#469) that name it from another file: a `textual`
 * row is a guess by name and does not count, a file's use of itself does not,
 * and neither does a test (the `test` rows, and every row written in a test
 * file, `isTestPath`); definitions in test files are not listed. The score
 * ranks and `refs` is what is shown:
 *   score = refs + 20 if the definition's file is under a `focus` entry
 *         + 5 per use from a `focus` file
 *         + 10 if a `query` word is part of its name + 5 if part of its path.
 * Uses guessed by name alone (`textual`, no unknown-receiver members) count half
 * (`guessed` in the entry): Python and Go cross-file calls are only ever guessed,
 * so without them every definition of those repositories ranks flat.
 * Ties go by path (code units), line, block id, so the same index answers the same
 * bytes. The signature is the first line of the stored snippet.
 *
 * Vault: the notes under a folder (live ones), ranked by the links that
 * name them from other notes of the vault (`note_links`), with the same query
 * and focus bonuses on the note path, as notes and folders one level below
 * the folder.
 *
 * Callers pass vaults and repositories the account may read; nothing here
 * checks access.
 */
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { textArray } from '../search/block-rows.js'
import { TEST_PATH } from './code-edges.js'

/** Entries per list and page (the issue's cap); the cursor goes on to the next ten definitions. */
export const ORIENT_ENTRIES = 10

export interface OrientSymbol {
  /** `path:line`. */
  at: string
  kind: string
  symbol: string
  sig: string
  /** Resolved uses from other non-test files. */
  refs: number
  /** Uses guessed by name alone (`textual`, not a member of an unknown receiver); absent when none. They rank below resolved ones. */
  guessed?: number
}

export interface OrientFolder {
  /** A folder (`src/lib/`) or a file one level below the requested folder. */
  path: string
  files: number
  refs: number
}

export interface OrientNote {
  /** A folder (`concepts/`) or a note one level below the requested folder. */
  path: string
  /** Notes in a folder; absent on a note. */
  notes?: number
  type?: string
  links: number
}

export interface OrientOptions {
  query?: string
  focus?: readonly string[]
  /** The folder whose level is shown, without slashes at its ends; null: the root. */
  folder: string | null
}

/** Definitions skipped: a page of `ORIENT_ENTRIES` further down the ranking (#534). */
export interface OrientOffsets {
  symbols?: number
}

/** The query's words as lower-case LIKE patterns (an `_` or `%` is not a wildcard), at most 8. */
function wordPatterns(query: string | undefined): string[] {
  const words = (query ?? '').toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []
  return [...new Set(words)].sort().slice(0, 8).map((w) => `%${w.replace(/[\\_%]/g, '\\$&')}%`)
}

/** Whether `column` is one of `focus` or under one that is a folder. */
const inFocus = (column: SQL, focus: readonly string[]): SQL =>
  focus.length === 0
    ? sql`false`
    : sql`EXISTS (SELECT 1 FROM unnest(${textArray(focus)}) AS fx(p) WHERE ${column} = fx.p OR starts_with(${column}, rtrim(fx.p, '/') || '/'))`

/** The folder's subtree on a `COLLATE "C"` path column: `folder/` <= path < `folder0` ('0' follows '/'). */
const underFolder = (column: SQL, folder: string | null): SQL =>
  folder === null ? sql`true` : sql`${column} COLLATE "C" >= ${`${folder}/`} AND ${column} COLLATE "C" < ${`${folder}0`}`

/** The definitions and folders of a repository at one level. */
export async function repositoryMap(
  repositoryId: string,
  opts: OrientOptions,
  offsets: OrientOffsets = {},
): Promise<{ symbols: OrientSymbol[]; folders: OrientFolder[] }> {
  const focus = opts.focus ?? []
  const words = wordPatterns(opts.query)
  const prefix = opts.folder === null ? '' : `${opts.folder}/`
  // Postgres counts characters, JS UTF-16 units.
  const skip = [...prefix].length + 1
  const named = words.length > 0 ? sql`(lower(b.inner_path) LIKE ANY(${textArray(words)}))` : sql`false`
  const pathed = words.length > 0 ? sql`(lower(f.path) LIKE ANY(${textArray(words)}))` : sql`false`
  // One row per definition under the folder with its score; the list and the folders read the same rows.
  const scored = sql`
    WITH uses AS (
      SELECT e.target_file_id AS file_id, e.target_block_id AS block_id,
        (count(*) FILTER (WHERE e.confidence = 'resolved'))::int AS n,
        (count(*) FILTER (WHERE e.confidence = 'textual' AND NOT e.member))::int AS guessed,
        (count(*) FILTER (WHERE e.confidence = 'resolved' AND ${inFocus(sql`sf.path`, focus)}))::int AS from_focus
      FROM code_edges e JOIN repository_files sf ON sf.id = e.source_file_id
      WHERE e.repository_id = ${repositoryId} AND (e.confidence = 'resolved' OR NOT e.member) AND e.kind IN ('call', 'reference', 'import')
        AND e.target_file_id IS NOT NULL AND e.source_file_id <> e.target_file_id AND NOT (sf.path ~ ${TEST_PATH.source})
      GROUP BY e.target_file_id, e.target_block_id
    ), defs AS (
      SELECT b.id, b.block_id, f.path, b.start_line AS line, b.inner_path AS symbol, b.symbol_kind AS kind, b.snippet,
        coalesce(u.n, 0) AS refs, coalesce(u.guessed, 0) AS guessed,
        coalesce(u.n, 0) + 0.5 * coalesce(u.guessed, 0) + 5 * coalesce(u.from_focus, 0) + (CASE WHEN ${inFocus(sql`f.path`, focus)} THEN 20 ELSE 0 END)
          + (CASE WHEN ${named} THEN 10 ELSE 0 END) + (CASE WHEN ${pathed} THEN 5 ELSE 0 END) AS score
      FROM blocks b JOIN repository_files f ON f.id = b.owner_id
        LEFT JOIN uses u ON u.file_id = b.owner_id AND u.block_id = b.block_id
      WHERE b.owner_type = 'code' AND b.container_id = ${repositoryId} AND b.kind = 'symbol'
        AND NOT (f.path ~ ${TEST_PATH.source}) AND ${underFolder(sql`f.path`, opts.folder)}
    )`
  const symbols = (await db.execute(sql`${scored}
    SELECT path, line, symbol, kind, snippet, refs, guessed FROM defs
    ORDER BY score DESC, path COLLATE "C", line, block_id
    LIMIT ${ORIENT_ENTRIES + 1} OFFSET ${offsets.symbols ?? 0}`)) as unknown as Array<{ path: string; line: number; symbol: string; kind: string; snippet: string | null; refs: number; guessed: number }>
  const folders = (await db.execute(sql`${scored}
    SELECT child AS path, count(DISTINCT def_file)::int AS files, sum(refs)::int AS refs FROM (
      SELECT ${prefix}::text || split_part(substr(path, ${skip}), '/', 1) || (CASE WHEN position('/' IN substr(path, ${skip})) > 0 THEN '/' ELSE '' END) AS child,
        path AS def_file, refs, score
      FROM defs) d
    GROUP BY child
    ORDER BY sum(score) DESC, child COLLATE "C"
    LIMIT ${ORIENT_ENTRIES + 1}`)) as unknown as OrientFolder[]
  return {
    symbols: symbols.map((r) => ({
      at: `${r.path}:${r.line}`,
      kind: r.kind,
      symbol: r.symbol,
      sig: (r.snippet ?? '').split('\n').find((l) => l.trim() !== '')?.trim() ?? r.symbol,
      refs: r.refs,
      ...(r.guessed > 0 ? { guessed: r.guessed } : {}),
    })),
    folders,
  }
}

/** The notes and folders of a vault at one level. */
export async function vaultOutline(vaultId: string, opts: OrientOptions): Promise<OrientNote[]> {
  const focus = opts.focus ?? []
  const words = wordPatterns(opts.query)
  const prefix = opts.folder === null ? '' : `${opts.folder}/`
  // Postgres counts characters, JS UTF-16 units.
  const skip = [...prefix].length + 1
  const pathed = words.length > 0 ? sql`(lower(n.path) LIKE ANY(${textArray(words)}))` : sql`false`
  const rows = (await db.execute(sql`
    WITH live AS (
      SELECT n.id, n.path, n.type FROM notes n
      WHERE n.vault_id = ${vaultId} AND n.deleted_at IS NULL AND ${underFolder(sql`n.path`, opts.folder)}
    ), scored AS (
      SELECT n.id, n.path, n.type, (SELECT count(*) FROM note_links l JOIN notes s ON s.id = l.source_note_id
          WHERE (l.target_path = n.path OR l.target_path = n.path || '.md') AND s.vault_id = ${vaultId} AND s.deleted_at IS NULL AND s.id <> n.id)::int AS links
      FROM live n
    )
    SELECT child AS path, (CASE WHEN is_dir THEN count(*)::int END) AS notes, (CASE WHEN is_dir THEN NULL ELSE min(type) END) AS type, sum(links)::int AS links
    FROM (
      SELECT ${prefix}::text || split_part(substr(n.path, ${skip}), '/', 1) || (CASE WHEN position('/' IN substr(n.path, ${skip})) > 0 THEN '/' ELSE '' END) AS child,
        position('/' IN substr(n.path, ${skip})) > 0 AS is_dir, n.type, n.links,
        n.links + (CASE WHEN ${pathed} THEN 10 ELSE 0 END) + (CASE WHEN ${inFocus(sql`n.path`, focus)} THEN 20 ELSE 0 END) AS score
      FROM scored n) d
    GROUP BY child, is_dir
    ORDER BY sum(score) DESC, child COLLATE "C"
    LIMIT ${ORIENT_ENTRIES + 1}`)) as unknown as Array<{ path: string; notes: number | null; type: string | null; links: number }>
  return rows.map((r) => (r.notes === null ? { path: r.path, type: r.type!, links: r.links } : { path: r.path, notes: r.notes, links: r.links }))
}
