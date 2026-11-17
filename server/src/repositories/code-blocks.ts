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
 *   path (`Guide > Install`), as a note section's. An outline block, never
 *   embedded (null `embed_key`): no search leg reads sections yet, and
 *   embedding them made indexing 2-3x slower on doc-heavy repositories
 *   (bench run 40193946217); #414/#415 decide whether they get vectors.
 *   `embedText` (`section <inner_path> in <path>\n<snippet>`, the snippet cut
 *   from its own text up to its first subsection, as a symbol's is) is what
 *   one would embed. Not a symbol: it has no `symbol_kind` and no stored
 *   snippet, so find_symbols and read_file's outline never list it.
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

/**
 * Bounds for a file that is built per call (ref/overlay views, ref-index.ts) instead of stored once: a declaration's first
 * line is cut to `lineChars` in a skeleton and a file's skeleton text stops at `skeletonChars`, so the generated text stays
 * a small multiple of the source however many declarations it has. The live index passes none (its lines are bounded by
 * the minified-file rule and its output is versioned by `CHUNK_VERSION`).
 */
export interface BlockBounds {
  lineChars: number
  skeletonChars: number
  /** One request's generated-text allowance, shared by every file it builds. */
  budget?: BlockBudget
}

/** The generated block text and block count one view build may create, charged before each file's blocks exist. */
export class BlockBudgetError extends Error {}
export class BlockBudget {
  constructor(readonly limits: { bytes: number; blocks: number }, public bytes = limits.bytes, public blocks = limits.blocks) {}
  /** Takes the estimated size of a file's whole block set, or refuses the request: nothing is allocated for a refused file. */
  reserve(bytes: number, blocks: number): void {
    if (bytes > this.bytes || blocks > this.blocks) {
      throw new BlockBudgetError(`generated block text over ${Math.round(this.limits.bytes / 1024 / 1024)} MiB or ${this.limits.blocks} blocks`)
    }
    this.bytes -= bytes
    this.blocks -= blocks
  }
}

/** Per-block constant text and bookkeeping charged on top of a block's snippet and embedded text. */
const BLOCK_OVERHEAD = 512

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
   * A symbol's place in the per-file embed budget (#496, #450): 0 exported,
   * 1 other top-level, 2 method. Null: not under the budget (file-level
   * blocks are always embedded; a class skeleton follows `outlineOf`; a
   * section is never embedded).
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
  bounds?: BlockBounds,
): CodeBlock[] {
  const starts = lineStarts(content)
  const total = starts.length
  const small = total <= SMALL_FILE_MAX_LINES && content.length <= MAX_EMBED_CHARS
  const hash = (start: number, end: number) => createHash('sha256').update(sliceLines(content, start, end, starts)).digest('hex')
  // Skeleton text left for this file (views only): lines are cut, then dropped, before they are joined.
  let skeletonLeft = bounds === undefined ? Infinity : Math.min(bounds.skeletonChars, content.length)
  const firstLine = (line: number) => {
    const text = sliceLines(content, line, line, starts)
    return bounds === undefined || text.length <= bounds.lineChars ? text : text.slice(0, bounds.lineChars)
  }
  const skeletonText = (head: string, lines: Iterable<number>) => {
    const parts = [head]
    for (const line of lines) {
      const text = firstLine(line)
      if (text.length + 1 > skeletonLeft) break
      skeletonLeft -= text.length + 1
      parts.push(text)
    }
    return parts.join('\n')
  }
  // Cut by code point, so an astral character is never split. A code point is at most two UTF-16 units: the cut text is
  // taken first, so a single huge line is never spread into an array of all its characters.
  const snippetOf = (start: number, end: number) =>
    [...sliceLines(content, start, Math.min(end, start + SNIPPET_LINES - 1), starts).slice(0, SNIPPET_CHARS * 2)].slice(0, SNIPPET_CHARS).join('')
  if (bounds?.budget) {
    // Reserve the whole file's block set from the request's allowance before any snippet, skeleton or embedded text is built.
    // Every generated string is counted at its UTF-8 upper bound (3 bytes per UTF-16 unit); the file text, whose bytes are known, exactly.
    const utf8 = (units: number) => 3 * units
    const span = (from: number, to: number) => (starts[Math.min(to, total)] ?? content.length) - (starts[from - 1] ?? content.length)
    const snippetUnits = (from: number, to: number) => Math.min(span(from, Math.min(to, from + SNIPPET_LINES - 1)), 2 * SNIPPET_CHARS)
    let bytes = Buffer.byteLength(content) + utf8(path.length) + BLOCK_OVERHEAD
    let blocks = 1
    for (const s of symbols) {
      const inner = (s.parent ? s.parent.length + 1 : 0) + s.name.length
      // innerPath is stored on the block and again in the embedded text, which also holds kind, path, line and the snippet; the snippet is stored too.
      bytes += utf8(2 * inner + 2 * snippetUnits(s.startLine, s.endLine) + path.length + 32) + BLOCK_OVERHEAD
      blocks += 1
    }
    for (const s of sections) {
      bytes += utf8(2 * s.innerPath.length + snippetUnits(s.startLine, s.ownEndLine) + path.length + 32) + BLOCK_OVERHEAD
      blocks += 1
    }
    if (!small && symbols.length + sections.length > 0) {
      // The file skeleton and each class skeleton share the file's skeleton text allowance; each adds a header (kind, qualified name, path) and a block.
      const classes = symbols.filter((s) => s.kind === 'class')
      bytes += utf8(bounds.skeletonChars + path.length + classes.reduce((n, s) => n + (s.parent ? s.parent.length + 1 : 0) + s.name.length + path.length + 16, 0)) + (classes.length + 1) * BLOCK_OVERHEAD
      blocks += 1 + classes.length
    }
    bounds.budget.reserve(bytes, blocks)
  }
  const methodsOf = new Map<string, ExtractedSymbol[]>()
  for (const m of small ? [] : symbols) {
    if (m.kind !== 'method' || !m.parent) continue
    const list = methodsOf.get(m.parent) ?? []
    if (list.length === 0) methodsOf.set(m.parent, list)
    list.push(m)
  }
  // Views (bounds given): several classes may share a name, and each owns the methods written inside its own lines, found by
  // binary search over the name's methods by start line; a single class of a name keeps them all (Go receivers sit outside the type).
  // The stored live index passes no bounds and keeps its by-name grouping (its output is versioned by CHUNK_VERSION).
  const classCount = new Map<string, number>()
  if (bounds) for (const s of small ? [] : symbols) if (s.kind === 'class') classCount.set(s.name, (classCount.get(s.name) ?? 0) + 1)
  if (bounds) for (const list of methodsOf.values()) list.sort((a, b) => a.startLine - b.startLine)
  /** The method start lines of class `s`, lazily, and whether it has any. */
  const methodLines = (s: ExtractedSymbol): { any: boolean; lines: () => Generator<number> } => {
    const list = methodsOf.get(s.name) ?? []
    if (!bounds || (classCount.get(s.name) ?? 0) <= 1) return { any: list.length > 0, lines: function* () { for (const m of list) yield m.startLine } }
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid]!.startLine < s.startLine) lo = mid + 1
      else hi = mid
    }
    return { any: lo < list.length && list[lo]!.startLine <= s.endLine, lines: function* () { for (let i = lo; i < list.length && list[i]!.startLine <= s.endLine; i++) yield list[i]!.startLine } }
  }

  const drafts: Array<Omit<CodeBlock, 'blockId'>> = []
  const whole = { innerPath: '', symbolKind: null, symbolParent: null, snippet: null, startLine: 1, endLine: total, contentHash: hash(1, total), budgetTier: null }
  drafts.push({ ...whole, kind: 'file', embedText: `${path}\n${content}` })
  const outlined = [...symbols, ...sections]
  if (!small && outlined.length > 0) {
    drafts.push({ ...whole, kind: 'skeleton', embedText: skeletonText(path, outlined.map((s) => s.startLine)) })
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
    const methods = s.kind === 'class' ? methodLines(s) : null
    if (methods?.any) {
      drafts.push({
        ...span,
        kind: 'skeleton',
        symbolKind: null,
        symbolParent: null,
        snippet: null,
        embedText: skeletonText(`${s.kind} ${innerPath} in ${path}`, (function* () { yield s.startLine; yield* methods.lines() })()),
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
      budgetTier: null,
    })
  }

  const siblings = siblingIndexes(drafts)
  return drafts.map((d, i) => ({ ...d, blockId: blockId(fileId, d.kind, d.innerPath, siblings[i]!) }))
}
