import { inArray } from 'drizzle-orm'
import { db, sql } from '../db/client.js'
import { notes, repositories, repositoryFiles, vaults } from '../db/schema.js'
import { bodyStartLine, renderNoteFile } from '../notes/projector.js'
import { lineStarts, sliceLines, totalLines } from '../text/lines.js'
import type { LineRange } from '../text/targets.js'
import { rangeTokens } from '../mcp/read-targets.js'
import { noteBlocks } from '../notes/note-blocks.js'
import { listFileBlocks } from './store.js'

/**
 * `grep` over notes and code (#468): a regular expression matched line by
 * line over the bodies of the live notes of vaults and the indexed files of
 * repositories, as located hits. Lines are the line contract's (text/lines.ts):
 * a note's lines are those of its file (`read_note`'s numbering, the body
 * starting at `body_start_line`), a code file's those of its indexed content
 * (only the indexed version is searched, never a working tree). Hits come in
 * path order (code-unit order, `COLLATE "C"`) then line order, vaults before
 * repositories, each by name then id, so the same question against the same
 * data answers the same hits in any database.
 *
 * The match runs in Postgres (`~`, an automaton-based engine): a pattern
 * is at most MAX_PATTERN characters, back references (the one construct that
 * backtracks without bound) are refused, and every statement runs under
 * `scanLimits.statementMs`. The scan is chunked, and bounded by `scanLimits` files, bytes
 * and milliseconds: a scan that stops there says so (`capped`) and its position
 * continues it. Access to the vaults and repositories is the caller's to check.
 */
export const MAX_PATTERN = 300
export const MAX_GLOB = 200
export const MAX_CONTEXT = 5
/** Hits a page fetches (the budget shows as many as fit; the cursor goes on). */
export const PAGE_HITS = 50
/** What one call scans before it stops and says so (tests lower them). */
export const scanLimits = { files: 20_000, bytes: 256 * 1024 * 1024, ms: 10_000, statementMs: 4_000 }
const CHUNK_FILES = 500
/** A line shown is cut here (a minified bundle is one line). */
const LINE_CHARS = 500
/** Block kinds of one span, most specific first. */
const KIND_RANK = ['symbol', 'section', 'preamble', 'skeleton', 'file']
/** The line a position past a whole file is at. */
const PAST_FILE = 2_147_483_647

export class GrepError extends Error {
  constructor(
    readonly code: 'INVALID_ARGUMENT' | 'BUSY',
    message: string,
    readonly field?: string,
  ) {
    super(message)
  }
}

export interface GrepTarget {
  kind: 'vault' | 'repository'
  id: string
  name: string
}

/** Where a scan resumes: target `c`, after line `line` of `path` (past `path` when `line` is PAST_FILE). */
export interface GrepPosition {
  c: number
  path: string
  line: number
}

/** A position as a cursor holds it: `<target>:<line>:<path>`. */
export const encodePosition = (p: GrepPosition): string => `${p.c}:${p.line}:${p.path}`

/** The position a cursor string holds, or null when it is not one. */
export function parsePosition(text: string): GrepPosition | null {
  const parsed = /^(\d+):(\d+):([^]*)$/.exec(text)
  return parsed && { c: Number(parsed[1]), line: Number(parsed[2]), path: parsed[3]! }
}

export interface GrepHit {
  vaultId?: string
  repositoryId?: string
  path: string
  /** The matching line. */
  line: number
  /** The lines of `snippet` (the match and its context), when there is context. */
  lines?: [number, number]
  /** The smallest block holding the line, and what reading it costs (`approxTokens`). */
  block?: string
  tokens?: number
  snippet: string
}

export interface GrepAnswer {
  hits: GrepHit[]
  /** Where the next page resumes after each hit. */
  positions: GrepPosition[]
  /** More hits match past `hits`. */
  more: boolean
  scanned: { files: number }
  /** The scan stopped at a cap before it had read everything: where it continues. */
  capped: GrepPosition | null
}

/**
 * The pattern as Postgres reads it: JavaScript's `\b` and `\B` are `\y` and `\Y`
 * there (`\b` is a backspace). A back reference is refused.
 */
export function translatePattern(pattern: string): string {
  if (pattern.length === 0) throw new GrepError('INVALID_ARGUMENT', 'pattern is empty', 'pattern')
  if (pattern.length > MAX_PATTERN) throw new GrepError('INVALID_ARGUMENT', `pattern is at most ${MAX_PATTERN} characters`, 'pattern')
  let out = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[++i]!
      if (/[1-9]/.test(next)) throw new GrepError('INVALID_ARGUMENT', 'back references are not supported: they can take unbounded time', 'pattern')
      out += !inClass && next === 'b' ? '\\y' : !inClass && next === 'B' ? '\\Y' : `\\${next}`
    } else if (inClass && c === '[' && pattern[i + 1] === ':') {
      const end = pattern.indexOf(':]', i + 2)
      const stop = end === -1 ? pattern.length : end + 2
      out += pattern.slice(i, stop)
      i = stop - 1
    } else if (!inClass && c === '[') {
      inClass = true
      out += c
      // A `^` and then a `]` first in the class are literal.
      if (pattern[i + 1] === '^') out += pattern[++i]
      if (pattern[i + 1] === ']') out += pattern[++i]
    } else {
      if (inClass && c === ']') inClass = false
      out += c
    }
  }
  return out
}

/**
 * A path glob as a Postgres regular expression over the whole path: `*` and `?`
 * stay within a folder, `**` crosses folders, `{a,b}` is a choice. A glob without
 * `/` matches the name at any depth (`*.ts`), as `rg -g` does.
 */
export function globToRegex(glob: string): string {
  if (glob.length > MAX_GLOB) throw new GrepError('INVALID_ARGUMENT', `path is at most ${MAX_GLOB} characters`, 'path')
  const full = glob.includes('/') ? glob : `**/${glob}`
  let out = ''
  let braces = 0
  for (let i = 0; i < full.length; i++) {
    const c = full[i]!
    if (c === '*' && full[i + 1] === '*') {
      const slash = full[i + 2] === '/'
      out += slash ? '(.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else if (c === '{') {
      braces++
      out += '('
    } else if (c === '}' && braces > 0) {
      braces--
      out += ')'
    } else if (c === ',' && braces > 0) out += '|'
    else out += /[A-Za-z0-9_/ -]/.test(c) ? c : c.charCodeAt(0) > 127 ? c : `\\${c}`
  }
  if (braces > 0) throw new GrepError('INVALID_ARGUMENT', 'unclosed `{` in the path glob', 'path')
  return `^${out}$`
}

/** Targets in answer order: vaults, then repositories, each by name (code-unit order) then id. */
export async function grepTargets(vaultIds: readonly string[], repositoryIds: readonly string[]): Promise<GrepTarget[]> {
  const [v, r] = await Promise.all([
    vaultIds.length ? db.select({ id: vaults.id, name: vaults.name }).from(vaults).where(inArray(vaults.id, [...vaultIds])) : [],
    repositoryIds.length ? db.select({ id: repositories.id, name: repositories.name }).from(repositories).where(inArray(repositories.id, [...repositoryIds])) : [],
  ])
  const byName = (a: { id: string; name: string }, b: { id: string; name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return [
    ...v.sort(byName).map((x) => ({ kind: 'vault' as const, ...x })),
    ...r.sort(byName).map((x) => ({ kind: 'repository' as const, ...x })),
  ]
}

interface Found {
  c: number
  id: string
  path: string
  n: number
}

/** The first `limit` hits of `pattern` from `after`, and whether more match or the scan was capped. */
export async function grep(
  targets: readonly GrepTarget[],
  args: { pattern: string; glob?: string; context: number; limit: number; after: GrepPosition | null },
): Promise<GrepAnswer> {
  const pattern = translatePattern(args.pattern)
  const glob = args.glob === undefined ? null : globToRegex(args.glob)
  const found: Found[] = []
  const scanned = { files: 0 }
  let capped: GrepPosition | null = null
  const started = Date.now()
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('statement_timeout', ${String(scanLimits.statementMs)}, true)`
      // An invalid pattern is refused here, not only when a line is first tested.
      await tx`SELECT '' ~ ${pattern}`
      let bytes = 0
      for (let c = args.after?.c ?? 0; c < targets.length; c++) {
        const target = targets[c]!
        const resumed = args.after !== null && c === args.after.c
        let after = resumed ? args.after!.path : ''
        let afterLine = resumed ? args.after!.line : 0
        const vault = target.kind === 'vault'
        for (;;) {
          const pathFilter = glob === null ? tx`` : tx`AND path ~ ${glob}`
          // A file the scan has read to its end is not read again.
          const fromPath = afterLine === PAST_FILE ? tx`path COLLATE "C" > ${after}` : tx`path COLLATE "C" >= ${after}`
          const candidates = vault
            ? await tx<Array<{ id: string; path: string; size: number }>>`
                SELECT id, path, octet_length(body)::int AS size FROM notes
                WHERE vault_id = ${target.id} AND deleted_at IS NULL AND ${fromPath} ${pathFilter}
                ORDER BY path COLLATE "C" LIMIT ${CHUNK_FILES}`
            : await tx<Array<{ id: string; path: string; size: number }>>`
                SELECT id, path, size FROM repository_files
                WHERE repository_id = ${target.id} AND ${fromPath} ${pathFilter}
                ORDER BY path COLLATE "C" LIMIT ${CHUNK_FILES}`
          if (candidates.length === 0) break
          if (scanned.files >= scanLimits.files || bytes >= scanLimits.bytes || Date.now() - started > scanLimits.ms) {
            capped = { c, path: after, line: afterLine }
            return
          }
          const ids = candidates.map((r) => r.id)
          // One row per matching line: the text split at `\n` only, a trailing `\r` not part of the line, and no empty line after a final `\n`.
          const room = args.limit + 1 - found.length
          const rows = await tx<Array<{ id: string; path: string; n: number }>>`
            SELECT f.id, f.path, l.n::int AS n
            FROM ${tx(vault ? 'notes' : 'repository_files')} f
            CROSS JOIN LATERAL regexp_split_to_table(${vault ? tx`f.body` : tx`f.content`}, chr(10)) WITH ORDINALITY AS l(line, n)
            WHERE f.id IN ${tx(ids)}
              AND regexp_replace(l.line, chr(13) || '$', '') ~ ${pattern}
              AND (f.path COLLATE "C" > ${after} OR l.n > ${afterLine})
              AND NOT (l.line = '' AND (${vault ? tx`f.body` : tx`f.content`} = '' OR (right(${vault ? tx`f.body` : tx`f.content`}, 1) = chr(10)
                AND l.n = 1 + length(${vault ? tx`f.body` : tx`f.content`}) - length(replace(${vault ? tx`f.body` : tx`f.content`}, chr(10), '')))))
            ORDER BY f.path COLLATE "C", l.n
            LIMIT ${room}`
          for (const row of rows) found.push({ c, id: row.id, path: row.path, n: row.n })
          scanned.files += candidates.length
          bytes += candidates.reduce((sum, r) => sum + r.size, 0)
          if (found.length > args.limit) return
          after = candidates.at(-1)!.path
          afterLine = PAST_FILE
          if (candidates.length < CHUNK_FILES) break
        }
      }
    })
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined
    if (code === '57014') throw new GrepError('BUSY', 'the scan took too long: narrow it with `path`, or a vault or repository')
    if (code === '2201B' || code === '2201C') throw new GrepError('INVALID_ARGUMENT', `invalid pattern: ${err instanceof Error ? err.message : String(err)}`, 'pattern')
    throw err
  }

  const more = found.length > args.limit
  const shown = found.slice(0, args.limit)
  // The text and blocks of the files that hit.
  const noteIds = [...new Set(shown.filter((f) => targets[f.c]!.kind === 'vault').map((f) => f.id))]
  const fileIds = [...new Set(shown.filter((f) => targets[f.c]!.kind === 'repository').map((f) => f.id))]
  const [noteRows, fileRows] = await Promise.all([
    noteIds.length ? db.select({ id: notes.id, frontmatter: notes.frontmatter, body: notes.body }).from(notes).where(inArray(notes.id, noteIds)) : [],
    fileIds.length ? db.select({ id: repositoryFiles.id, content: repositoryFiles.content, contentHash: repositoryFiles.contentHash }).from(repositoryFiles).where(inArray(repositoryFiles.id, fileIds)) : [],
  ])
  interface Doc {
    text: string
    starts: number[]
    offset: number
    blocks: ReadonlyArray<{ block: string; kind: string; innerPath: string; lines: LineRange }>
  }
  const docs = new Map<string, Doc>()
  for (const row of noteRows) {
    const path = shown.find((f) => f.id === row.id)!.path
    const file = renderNoteFile({ frontmatter: row.frontmatter, frontmatterSrc: null, body: row.body })
    const offset = bodyStartLine({ frontmatter: row.frontmatter, frontmatterSrc: null }) - 1
    docs.set(row.id, { text: file, starts: lineStarts(file), offset, blocks: noteBlocks(row.id, path, row.body)
        .filter((b) => b.endLine >= b.startLine)
        .map((b) => ({ block: b.blockId, kind: b.kind, innerPath: b.innerPath, lines: [b.startLine + offset, b.endLine + offset] as LineRange })),
    })
  }
  for (const row of fileRows) {
    const { blocks } = await listFileBlocks(row.id, row.contentHash)
    docs.set(row.id, { text: row.content, starts: lineStarts(row.content), offset: 0, blocks: blocks
        .filter((b) => b.endLine >= b.startLine)
        .map((b) => ({ block: b.blockId, kind: b.kind, innerPath: b.innerPath, lines: [b.startLine, b.endLine] as LineRange })),
    })
  }

  // A note or file deleted since the scan has no hit.
  const positions: GrepPosition[] = []
  const hits: GrepHit[] = shown.flatMap((f) => {
    const doc = docs.get(f.id)
    if (!doc) return []
    const target = targets[f.c]!
    const line = f.n + doc.offset
    const first = Math.max(1, line - args.context)
    const last = Math.min(totalLines(doc.text), line + args.context)
    // The smallest block holding the line; blocks of one span (a file's `parse` symbol and its `file` block) by kind, then inner
    // path, never by id or row order (ids differ per database: #473, #1083). A block id decides only blocks equal in all of them.
    const block = doc.blocks
      .filter((b) => b.lines[0] <= line && line <= b.lines[1])
      .sort(
        (a, b) =>
          a.lines[1] - a.lines[0] - (b.lines[1] - b.lines[0]) ||
          KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind) ||
          (a.innerPath < b.innerPath ? -1 : a.innerPath > b.innerPath ? 1 : 0) ||
          (a.block < b.block ? -1 : a.block > b.block ? 1 : 0),
      )[0]
    const snippet = sliceLines(doc.text, first, last, doc.starts)
      .split('\n')
      .map((l) => (l.length > LINE_CHARS ? l.slice(0, LINE_CHARS) : l))
      .join('\n')
    positions.push({ c: f.c, path: f.path, line: f.n })
    return [{
      ...(targets.length === 1 ? {} : target.kind === 'vault' ? { vaultId: target.id } : { repositoryId: target.id }),
      path: f.path,
      line,
      ...(first === last ? {} : { lines: [first, last] as [number, number] }),
      ...(block ? { block: block.block, tokens: rangeTokens(doc.text, doc.starts, block.lines) } : {}),
      snippet,
    }]
  })
  // A position is a scan's: a note's lines are numbered over its body there, over its file in the hit.
  return { hits, positions, more, scanned, capped }
}
