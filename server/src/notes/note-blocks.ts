/**
 * A note body as blocks (#452b; ADR-004 §2.2, §2.5): what the embed job
 * stores and embeds per note. Pure; versioned by search/embed-key.ts
 * `CHUNK_VERSION` (bump it with any change here).
 *
 * - `preamble`: the body before its first heading, when it is not blank. A
 *   body with no heading that is empty or blank is one preamble too (an
 *   empty body spans no line, 1..0), so every note has at least one block
 *   and stays in the vector leg; its embedded text is then the path.
 * - `section`: one per heading (text/blocks.ts `headings`, so not inside a
 *   code fence), from the heading line through the line before the next
 *   heading of the same or a higher level: a nested section overlaps its
 *   parent. `inner_path` is the heading titles from the top level down,
 *   joined with ` > `.
 *
 * A section embeds its own text only: its heading line up to its first
 * child heading. Its children are blocks of their own, so no text is
 * embedded twice, and an edit in a child changes no ancestor's text (the
 * model reads 512 tokens, so a parent's whole span would mostly be cut off
 * anyway). Own text longer than `NOTE_CHUNK_CHARS` is cut on line boundaries
 * into pieces with the same kind and inner path, numbered by `sibling_index`
 * in order; each piece spans its own lines and the last one ends where the
 * section ends, children included. A single line longer than the cap stays
 * one piece (the embedder cuts it at `MAX_EMBED_CHARS`). The preamble is cut
 * the same way.
 *
 * Embedded text: `<path>\n<inner_path>\n<piece>` (a preamble:
 * `<path>\n<piece>`), never the frontmatter, so a frontmatter-only edit
 * changes no block. Lines are body-relative (§2.2 storage rule) and every
 * text is a substring of the body (text/lines.ts); `content_hash` is the
 * sha256 of the block's lines.
 */
import { createHash } from 'node:crypto'
import { blockId, headings, siblingIndexes } from '../text/blocks.js'
import { lineStarts, sliceLines } from '../text/lines.js'

/**
 * The most characters of own text one block embeds: about 512 tokens of
 * English for bge-small (the model's window), with room for the path and
 * heading path above it.
 */
export const NOTE_CHUNK_CHARS = 2000

export interface NoteBlock {
  blockId: string
  kind: 'preamble' | 'section'
  innerPath: string
  /** Body-relative, 1-based and inclusive; answers add `body_start_line - 1`. */
  startLine: number
  endLine: number
  /** sha256 (hex) of lines startLine..endLine of the body. */
  contentHash: string
  embedText: string
}

export function noteBlocks(noteId: string, path: string, body: string): NoteBlock[] {
  const starts = lineStarts(body)
  const total = starts.length
  const lineAt = new Map(starts.map((offset, i) => [offset, i + 1]))
  const found = headings(body).map((h) => ({ ...h, lineNo: lineAt.get(h.start)! }))
  const drafts: Array<Omit<NoteBlock, 'blockId'>> = []

  const draft = (kind: NoteBlock['kind'], innerPath: string, a: number, b: number, end: number, head: string) => ({
    kind,
    innerPath,
    startLine: a,
    endLine: end,
    contentHash: createHash('sha256').update(sliceLines(body, a, end, starts)).digest('hex'),
    embedText: head + sliceLines(body, a, b, starts),
  })
  /** Own lines a..b cut into pieces of at most NOTE_CHUNK_CHARS; the last piece ends at `end`. */
  const pieces = (kind: NoteBlock['kind'], innerPath: string, a: number, b: number, end: number) => {
    const head = kind === 'preamble' ? `${path}\n` : `${path}\n${innerPath}\n`
    let from = a
    let size = 0
    for (let line = a; line <= b; line++) {
      const length = (line < total ? starts[line]! : body.length) - starts[line - 1]!
      if (line > from && size + length > NOTE_CHUNK_CHARS) {
        drafts.push(draft(kind, innerPath, from, line - 1, line - 1, head))
        from = line
        size = 0
      }
      size += length
    }
    drafts.push(draft(kind, innerPath, from, b, end, head))
  }

  const preambleEnd = found.length > 0 ? found[0]!.lineNo - 1 : total
  if (found.length === 0 && sliceLines(body, 1, total, starts).trim() === '') {
    drafts.push({ ...draft('preamble', '', 1, total, total, ''), embedText: path })
  } else if (preambleEnd >= 1 && sliceLines(body, 1, preambleEnd, starts).trim() !== '') {
    pieces('preamble', '', 1, preambleEnd, preambleEnd)
  }

  const trail: Array<{ level: number; title: string }> = []
  found.forEach((h, i) => {
    while (trail.length > 0 && trail.at(-1)!.level >= h.level) trail.pop()
    trail.push({ level: h.level, title: h.title })
    const ownEnd = i + 1 < found.length ? found[i + 1]!.lineNo - 1 : total
    const next = found.findIndex((o, j) => j > i && o.level <= h.level)
    const end = next === -1 ? total : found[next]!.lineNo - 1
    pieces('section', trail.map((t) => t.title).join(' > '), h.lineNo, ownEnd, end)
  })

  const siblings = siblingIndexes(drafts)
  return drafts.map((d, i) => ({ ...d, blockId: blockId(noteId, d.kind, d.innerPath, siblings[i]!) }))
}
