import { z } from 'zod'
import { sql } from '../db/client.js'
import { openSession } from '../cache/session.js'
import { totalLines, sliceLines } from '../text/lines.js'
import { viewId, viewVersion, type RepositoryView } from '../repositories/ref-index.js'
import { searchRef } from '../repositories/ref-search.js'
import { routeRef } from '../repositories/ref-router.js'
import type { SearchRoute } from '../search/router.js'
import { leanHit } from './search-hit.js'
import { translatePattern, globToRegex, scanLimits, encodePosition, parsePosition, type GrepHit } from '../repositories/grep.js'
import { checkReadArgs, codeParts, markdownParts, MARKDOWN_PATH, targetSections, outlineFirst, outlineSection, outlineNarrow, largeNarrow, unchanged, type Target } from './read-targets.js'
import { inSession } from './session-reads.js'
import { keyset, ranked, textSection, location, compareCodeUnits, type Budgeted, type Page } from './response.js'
import { McpToolError } from './errors.js'

// Two shared optional fields; no cross-tool stored overlay handle or implicit session overlay.
export const REF_INPUT = {
  ref: z.string().optional().describe('Git ref'),
  overlay: z.string().optional().describe('Private diff'),
}
export async function readView(view: RepositoryView, args: { path: string; targets?: Target[]; outline?: boolean; if_rev?: string; session_id?: string }, page: Page, connectionId: string): Promise<Budgeted> {
  checkReadArgs(args)
  const path = args.path.split('/').filter((p) => p !== '' && p !== '.').join('/')
  const file = view.files.get(path)
  if (!file) {
    if (view.entries?.has(path)) throw new McpToolError('INVALID_ARGUMENT', 'this Git entry has no indexed UTF-8 text (binary, too large, symlink or submodule)', { field: 'path' })
    throw new McpToolError('NOT_FOUND', 'file not found in this ref/overlay', { field: 'path' })
  }
  const hash = file.contentHash.slice(0, 16)
  const version = viewVersion(view)
  const head = { ...version, path, language: file.language, hash }
  // Only passage hashes/locations are remembered; overlay bytes never enter shared tables.
  const session = args.session_id === undefined ? null : await openSession(connectionId, args.session_id, viewId(`${view.repositoryId}\0${view.source}\0${file.path}`))
  const doc = { path, version: { hash }, text: file.content }
  const wrap = (answer: Budgeted) => inSession(session, doc, answer, page.at)
  if (page.at === null && args.if_rev === hash) return wrap({ ...unchanged({ hash }), head: { ...head, unchanged: true } })
  const code = codeParts(file.blocks, file.content)
  const markdown = MARKDOWN_PATH.test(path) ? markdownParts(file.id, path, file.content, file.content, 0) : null
  const parts = { blocks: [...code.blocks, ...(markdown?.blocks ?? [])], symbols: code.symbols, headings: markdown?.headings ?? 'use symbol or lines', outline: code.outline.length || !markdown ? code.outline : markdown.outline }
  const located = { ...head, total_lines: totalLines(file.content) }
  if (args.targets) return wrap({ head: located, sections: targetSections({ text: file.content, ...parts }, args.targets) })
  const outline = await outlineFirst(args.outline, page.at, () => parts.outline)
  if (outline) return wrap({ head: located, sections: [outlineSection(outline), textSection({ name: 'content', text: file.content, lines: true, withheld: true })], narrow: [...outlineNarrow(outline), ...largeNarrow(file.content, true)] })
  const symbols = file.structure.symbols.map((s) => ({ name: s.name, kind: s.kind, startLine: s.startLine, endLine: s.endLine, ...(s.parent ? { parent: s.parent } : {}) }))
  return wrap({ head, sections: [outlineSection(null), textSection({ name: 'content', text: file.content, lines: true }), ranked({ name: 'symbols', items: symbols, id: (s) => `${s.startLine}:${s.kind}:${s.name}`, ladder: { group: (s) => s.kind } })], narrow: largeNarrow(file.content) })
}

export function browseView(view: RepositoryView, path: string | undefined, page: Page): Budgeted {
  const folder = path?.split('/').filter((p) => p !== '' && p !== '.').join('/') || ''
  const after = page.after(0, z.string())
  const rows = [...view.files.values()].filter((f) => (!folder || f.path.startsWith(`${folder}/`)) && (after === null || compareCodeUnits(f.path, after) > 0)).sort((a, b) => compareCodeUnits(a.path, b.path)).slice(0, 101).map((f) => ({ path: f.path, language: f.language, size: f.size }))
  if (folder && rows.length === 0 && after === null) throw new McpToolError('NOT_FOUND', view.files.has(folder) ? 'path is a file: use read_file' : 'folder not found in this ref/overlay', { field: 'path' })
  return { head: viewVersion(view), sections: [keyset({ name: 'files', items: rows.slice(0, 100), limit: 100, more: rows.length > 100, resume: (r) => r.path, ladder: { no_context: ({ path, language }) => ({ path, language }), locations: (r) => r.path, group: (r) => r.path.split('/').slice(0, -1).join('/') } })] }
}

/** Both channels rank only the immutable tree plus this call's overlay. */
export async function searchView(view: RepositoryView, accountId: string, args: { query: string; kind?: string; limit?: number; symbols?: boolean; route?: SearchRoute }, symbolsOnly: boolean): Promise<Budgeted> {
  const limit = args.limit ?? 20
  let attempted: SearchRoute = 'conceptual'
  if (!symbolsOnly) {
    const answer = await routeRef(view, args.query, args.symbols ?? true, args.route)
    attempted = answer.attempted
    if (answer.routed) {
      const { results, textual, ...head } = answer.routed
      const items = results.map((h) => leanHit(h, true))
      return {
        head: { ...viewVersion(view), ...head, status: results.length ? 'ok' : 'no_match', retrieval_mode: 'exact', degraded: false, ...(results.length > limit || (textual?.length ?? 0) > limit ? { partial: true } : {}) },
        sections: [
          ranked({ name: 'results', items, id: (h) => `${h.id}:${h.startLine ?? ''}:${h.edge?.kind ?? ''}:${h.edge?.col ?? ''}`, limit, ladder: { no_context: (h) => ({ ...h, snippet: undefined, tokens: undefined }), locations: (h) => h.startLine === undefined || h.endLine === undefined ? h.path : location(h.path, h.startLine, h.endLine), group: (h) => h.path } }),
          ...(textual === undefined ? [] : [ranked({ name: 'textual', items: textual, id: (h) => `${h.repositoryId}:${h.path}:${h.line}:${h.col}:${h.kind}`, limit, ladder: { no_context: (h) => ({ ...h, context: undefined }), locations: (h) => h.line === null ? h.path : location(h.path, h.line, h.line), group: (h) => h.path } })]),
        ],
      }
    }
  }
  const hits = await searchRef(view, accountId, args, symbolsOnly)
  const items = hits.map((h) => {
    const file = view.files.get(h.path)!
    if (symbolsOnly) return { ...h, fileId: file.id, repositoryId: view.repositoryId }
    return {
      id: h.id, path: h.path, resourceType: h.name ? 'symbol' : 'code', ...(file.language ? { language: file.language } : {}),
      ...(h.name ? { symbolName: h.name, symbolKind: h.kind, ...(h.parent ? { symbolParent: h.parent } : {}) } : {}),
      ...(h.startLine === undefined || h.endLine === undefined ? {} : { startLine: h.startLine, endLine: h.endLine, tokens: Math.ceil(sliceLines(file.content, h.startLine, h.endLine).length / 4) }),
      snippet: h.snippet, score: Math.round(h.score * 1e5) / 1e5,
    }
  })
  const retrieval = /[\p{L}\p{N}]/u.test(args.query) ? 'hybrid' : 'none'
  const fallback = !symbolsOnly && attempted !== 'conceptual'
  return { head: { ...viewVersion(view), status: hits.length ? 'ok' : 'no_match', retrieval_mode: fallback && retrieval !== 'none' ? 'fallback' : retrieval, degraded: false, ...(!symbolsOnly ? { route: 'conceptual', ...(fallback ? { attempted_route: attempted, ...(retrieval !== 'none' ? { underlying_retrieval_mode: retrieval } : {}) } : {}) } : {}) }, sections: [ranked({ name: 'results', items, id: (h) => h.id, limit, ladder: { no_context: (h) => ({ ...h, snippet: undefined }), locations: (h) => h.startLine === undefined || h.endLine === undefined ? h.path : location(h.path, h.startLine, h.endLine), group: (h) => h.path } })] }
}

/** PostgreSQL's bounded regex engine, exactly as normal grep; input is data, never a SQL fragment or JS regexp. */
export async function grepView(view: RepositoryView, args: { pattern: string; path?: string; context?: number }, page: Page): Promise<Budgeted> {
  const pattern = translatePattern(args.pattern)
  const glob = args.path === undefined ? null : globToRegex(args.path.replace(/^(?:\.?\/)+/, ''))
  const at = page.after(0, z.string().regex(/^0:\d+:/))
  const after = at === null ? null : parsePosition(at)
  const limit = 20
  const documents = JSON.stringify([...view.files.values()].map((f) => ({ path: f.path, content: f.content })))
  let rows: Array<{ path: string; line: number }>
  try {
    rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('statement_timeout', ${String(scanLimits.statementMs)}, true)`
      await tx`SELECT '' ~ ${pattern}`
      return tx<Array<{ path: string; line: number }>>`
        SELECT f.path, l.n::int AS line
        FROM jsonb_to_recordset(${documents}::jsonb) AS f(path text, content text)
        CROSS JOIN LATERAL regexp_split_to_table(f.content, chr(10)) WITH ORDINALITY AS l(text, n)
        WHERE (${glob}::text IS NULL OR f.path ~ ${glob}) AND regexp_replace(l.text, chr(13) || '$', '') ~ ${pattern}
          AND (${after?.path ?? null}::text IS NULL OR f.path COLLATE "C" > ${after?.path ?? ''} OR (f.path = ${after?.path ?? ''} AND l.n > ${after?.line ?? 0}))
          AND NOT (l.text = '' AND (f.content = '' OR (right(f.content, 1) = chr(10) AND l.n = 1 + length(f.content) - length(replace(f.content, chr(10), '')))))
        ORDER BY f.path COLLATE "C", l.n LIMIT ${limit + 1}`
    })
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined
    if (code === '57014') throw new McpToolError('BUSY', 'regex scan took too long: narrow path')
    if (code === '2201B' || code === '2201C') throw new McpToolError('INVALID_ARGUMENT', 'invalid regular expression', { field: 'pattern' })
    throw err
  }
  const hits: GrepHit[] = rows.slice(0, limit).map((r) => {
    const f = view.files.get(r.path)!
    const first = Math.max(1, r.line - (args.context ?? 0))
    const last = Math.min(totalLines(f.content), r.line + (args.context ?? 0))
    const block = f.blocks.filter((b) => b.startLine <= r.line && b.endLine >= r.line).sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0]
    return { path: r.path, line: r.line, ...(first === last ? {} : { lines: [first, last] as [number, number] }), ...(block ? { tokens: Math.ceil(sliceLines(f.content, block.startLine, block.endLine).length / 4) } : {}), snippet: sliceLines(f.content, first, last).split('\n').map((l) => l.slice(0, 500)).join('\n') }
  })
  return { head: { ...viewVersion(view), scanned: view.files.size }, sections: [keyset({ name: 'hits', items: hits, limit, more: rows.length > limit, resume: (h) => encodePosition({ c: 0, path: h.path, line: h.line }), ladder: { no_context: (h) => ({ ...h, snippet: undefined }), locations: (h) => location(h.path, h.lines?.[0] ?? h.line, h.lines?.[1] ?? h.line), group: (h) => h.path } })] }
}

/** Git C-quoted UTF-8 path, including control bytes JSON's \\u escapes cannot represent in patches. */
function quoteGitPath(path: string): string {
  let quoted = '"'
  for (const byte of Buffer.from(path)) quoted += byte === 34 ? '\\"' : byte === 92 ? '\\\\' : byte < 32 || byte >= 127 ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte)
  return `${quoted}"`
}

/** A valid full-file unified patch, without external diff tools, checkout, renames or text execution. */
export function diffView(base: RepositoryView, target: RepositoryView, path: string | undefined): Budgeted {
  const folder = path?.split('/').filter((p) => p !== '' && p !== '.').join('/')
  const paths = [...new Set([...base.files.keys(), ...target.files.keys(), ...(base.entries?.keys() ?? []), ...(target.entries?.keys() ?? [])])].filter((p) => !folder || p === folder || p.startsWith(`${folder}/`)).sort(compareCodeUnits)
  const chunks: string[] = []
  const metadata: Array<{ path: string; kind: string; reason: string; before?: { sha: string; mode: string }; after?: { sha: string; mode: string } }> = []
  for (const p of paths) {
    const before = base.files.get(p)
    const after = target.files.get(p)
    const old = base.entries?.get(p)
    const next = target.entries?.get(p)
    if (old || next) {
      if (old?.sha === next?.sha && old?.mode === next?.mode && old?.type === next?.type) continue
    } else if (before?.contentHash === after?.contentHash) continue
    if (old && !before || next && !after) {
      const entry = next ?? old!
      const reason = entry.type === 'commit' ? 'submodule' : entry.mode === '120000' ? 'symlink' : (target.skipped.find((f) => f.path === p) ?? base.skipped.find((f) => f.path === p))?.reason ?? 'unindexed_text'
      metadata.push({ path: p, kind: !old ? 'added' : !next ? 'deleted' : 'modified', reason, ...(old ? { before: { sha: old.sha, mode: old.mode } } : {}), ...(next ? { after: { sha: next.sha, mode: next.mode } } : {}) })
      continue
    }
    chunks.push(`diff --git ${quoteGitPath(`a/${p}`)} ${quoteGitPath(`b/${p}`)}`)
    if (!before) chunks.push(`new file mode ${next?.mode ?? '100644'}`)
    else if (!after) chunks.push(`deleted file mode ${old?.mode ?? '100644'}`)
    else if (old && next && old.mode !== next.mode) chunks.push(`old mode ${old.mode}`, `new mode ${next.mode}`)
    if (old || next) {
      const zeros = '0'.repeat((next ?? old)!.sha.length)
      chunks.push(`index ${old?.sha ?? zeros}..${next?.sha ?? zeros}${old?.mode === next?.mode ? ` ${old!.mode}` : ''}`)
    }
    if (before && after && before.contentHash === after.contentHash) continue
    const oldLines = !before || before.content === '' ? [] : before.content.replace(/\n$/, '').split('\n')
    const newLines = !after || after.content === '' ? [] : after.content.replace(/\n$/, '').split('\n')
    if (oldLines.length === 0 && newLines.length === 0) continue
    chunks.push(`--- ${before ? quoteGitPath(`a/${p}`) : '/dev/null'}`, `+++ ${after ? quoteGitPath(`b/${p}`) : '/dev/null'}`, `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`)
    for (const l of oldLines) chunks.push(`-${l}`)
    if (before && oldLines.length && !before.content.endsWith('\n')) chunks.push('\\ No newline at end of file')
    for (const l of newLines) chunks.push(`+${l}`)
    if (after && newLines.length && !after.content.endsWith('\n')) chunks.push('\\ No newline at end of file')
  }
  return {
    head: { ...viewVersion(target), base: viewVersion(base) },
    sections: [
      textSection({ name: 'diff', text: chunks.length ? `${chunks.join('\n')}\n` : '', lines: true }),
      ...(metadata.length ? [ranked({ name: 'metadata', items: metadata, id: (m) => m.path, ladder: { locations: (m) => `${m.kind} ${m.path}`, group: (m) => m.reason } })] : []),
    ],
  }
}
