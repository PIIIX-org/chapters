/**
 * A repository file as blocks (#413, #452a; ADR-004 §2.2, §2.5): what
 * extraction stores and embeds per file. Pure; versioned by embed-key.ts
 * `CHUNK_VERSION` (bump it with any change here), except what it is given:
 * the symbols and sections extraction finds, which `EXTRACTOR_VERSION` versions.
 *
 * - `symbol`: one per extracted symbol, its lines; `inner_path` is
 *   `Class.method` for a method (#450's `parent`), the bare name otherwise.
 * - `section`: one per heading of a Markdown or HTML file (outline.ts,
 *   #464), its lines (its subsections included); `inner_path` is the heading
 *   path (`Guide > Install`), as a note section's. Embedded text:
 *   `section <inner_path> in <path>\n<snippet>`, the snippet cut from its own
 *   text (up to its first subsection) as a symbol's is. Not a symbol: it has
 *   no `symbol_kind` and no stored snippet, so find_symbols and read_file's
 *   outline never list it.
 * - `file`: the whole file, for every file. Embedded text:
 *   `<path>\n<content>`, as the file vector was (the model reads its first
 *   512 tokens); search's code vector leg ranks files by it.
 * - `skeleton`: the outline of a file that is not small (more than
 *   `SMALL_FILE_MAX_LINES` lines or `MAX_EMBED_CHARS` characters, so its
 *   `file` vector covers only its head) and has symbols or sections
 *   (`<path>` then each one's first line), and of each class in it with
 *   methods (`<kind> <Class> in <path>`, the class's first line, then each
 *   method's first line).
 *
 * The file-level blocks (`file`, and a file `skeleton`) are always
 * embedded; the `file` block comes first. Ranking a file by its skeleton
 * instead of its head was measured worse (chapters A13: a 304-line hook's
 * outline outranked the 80-line answer, hit@5 0.9655 -> 0.931). A symbol's embedded text is
 * `<kind> <inner_path> in <path>:<start line>\n<snippet>`, the snippet being
 * its first `SNIPPET_LINES` lines cut to `SNIPPET_CHARS` code points. The
 * line stays in the text: without it chapters A13 left the top 5 (bench run
 * 40076821407 vs 40076707623, hit@5 0.9655 vs 1), so a symbol whose lines
 * moved is embedded again (its id stays).
 * An empty file's `file` block spans no line (1..0).
 */
import { createHash } from 'node:crypto'
import { MAX_EMBED_CHARS } from '../search/embeddings.js'
import { blockId, siblingIndexes } from '../text/blocks.js'
import { lineStarts, sliceLines } from '../text/lines.js'
import type { ExtractedSymbol, SymbolKind } from './extraction.js'
import type { OutlineSection } from './outline.js'

export const SMALL_FILE_MAX_LINES = 300
/** A symbol snippet (stored on the block; search hits, embedded text): its first lines, cut to this many code points. */
export const SNIPPET_LINES = 30
export const SNIPPET_CHARS = 1500

export interface CodeBlock {
  blockId: string
  kind: 'symbol' | 'section' | 'skeleton' | 'file'
  innerPath: string
  /** A symbol block's SymbolKind; null on the others. */
  symbolKind: SymbolKind | null
  /** A symbol block's `parent` (#450); null at module level and on the others. */
  symbolParent: string | null
  startLine: number
  endLine: number
  /** sha256 (hex) of lines startLine..endLine of the stored text. */
  contentHash: string
  /** A symbol block's snippet (stored, matched and returned by search); null on the others. */
  snippet: string | null
  embedText: string
  /**
   * A symbol's or section's place in the per-file embed budget (#496, #450):
   * 0 exported, 1 other top-level (and every section, #464), 2 method.
   * Null: not under the budget (file-level blocks are always embedded; a
   * class skeleton follows `outlineOf`).
   */
  budgetTier: 0 | 1 | 2 | null
  /** A class skeleton: the index of its class's symbol block; embedded only when that block is. */
  outlineOf?: number
}

export function codeBlocks(
  fileId: string,
  path: string,
  content: string,
  symbols: readonly ExtractedSymbol[],
  sections: readonly OutlineSection[] = [],
): CodeBlock[] {
  const starts = lineStarts(content)
  const total = starts.length
  const small = total <= SMALL_FILE_MAX_LINES && content.length <= MAX_EMBED_CHARS
  const hash = (start: number, end: number) => createHash('sha256').update(sliceLines(content, start, end, starts)).digest('hex')
  const firstLine = (line: number) => sliceLines(content, line, line, starts)
  // Cut by code point, so an astral character is never split.
  const snippetOf = (start: number, end: number) =>
    [...sliceLines(content, start, Math.min(end, start + SNIPPET_LINES - 1), starts)].slice(0, SNIPPET_CHARS).join('')
  const methodsOf = new Map<string, ExtractedSymbol[]>()
  for (const m of small ? [] : symbols) {
    if (m.kind !== 'method' || !m.parent) continue
    const list = methodsOf.get(m.parent) ?? []
    if (list.length === 0) methodsOf.set(m.parent, list)
    list.push(m)
  }

  const drafts: Array<Omit<CodeBlock, 'blockId'>> = []
  const whole = { innerPath: '', symbolKind: null, symbolParent: null, snippet: null, startLine: 1, endLine: total, contentHash: hash(1, total), budgetTier: null }
  drafts.push({ ...whole, kind: 'file', embedText: `${path}\n${content}` })
  const outlined = [...symbols, ...sections]
  if (!small && outlined.length > 0) {
    drafts.push({ ...whole, kind: 'skeleton', embedText: [path, ...outlined.map((s) => firstLine(s.startLine))].join('\n') })
  }

  for (const s of symbols) {
    const innerPath = s.parent ? `${s.parent}.${s.name}` : s.name
    const snippet = snippetOf(s.startLine, s.endLine)
    const span = { innerPath, startLine: s.startLine, endLine: s.endLine, contentHash: hash(s.startLine, s.endLine) }
    const at =
      drafts.push({
        ...span,
        kind: 'symbol',
        symbolKind: s.kind,
        symbolParent: s.parent ?? null,
        snippet,
        embedText: `${s.kind} ${innerPath} in ${path}:${s.startLine}\n${snippet}`,
        budgetTier: s.kind === 'method' ? 2 : s.exported ? 0 : 1,
      }) - 1
    const methods = s.kind === 'class' ? (methodsOf.get(s.name) ?? []) : []
    if (methods.length > 0) {
      drafts.push({
        ...span,
        kind: 'skeleton',
        symbolKind: null,
        symbolParent: null,
        snippet: null,
        embedText: [`${s.kind} ${innerPath} in ${path}`, firstLine(s.startLine), ...methods.map((m) => firstLine(m.startLine))].join('\n'),
        budgetTier: null,
        outlineOf: at,
      })
    }
  }
  for (const s of sections) {
    drafts.push({
      kind: 'section',
      innerPath: s.innerPath,
      symbolKind: null,
      symbolParent: null,
      snippet: null,
      startLine: s.startLine,
      endLine: s.endLine,
      contentHash: hash(s.startLine, s.endLine),
      embedText: `section ${s.innerPath} in ${path}\n${snippetOf(s.startLine, s.ownEndLine)}`,
      budgetTier: 1,
    })
  }

  const siblings = siblingIndexes(drafts)
  return drafts.map((d, i) => ({ ...d, blockId: blockId(fileId, d.kind, d.innerPath, siblings[i]!) }))
}
