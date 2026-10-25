/**
 * Blocks (ADR-004 §2.2, #413): the addressable spans of a note or a
 * repository file, which are also its embedding chunks (§2.5, #452). A
 * block's id names it by what it is, never by where it is, so it survives
 * edits elsewhere and line shifts; renaming its heading or symbol changes it.
 * Pure functions, shared by code extraction and (#452b) the note store; the
 * heading parser here is the one `replace_section` uses too (sync/edit-ops.ts).
 */
import { createHash } from 'node:crypto'

/**
 * `preamble`: a note's text before its first heading; `section`: a heading
 * through the next heading of the same or a higher level; `symbol`: a
 * declaration; `skeleton`: a file or class outline; `file`: a whole file.
 */
export const BLOCK_KINDS = ['preamble', 'section', 'symbol', 'skeleton', 'file'] as const
export type BlockKind = (typeof BLOCK_KINDS)[number]

/** RFC 4648 base32 alphabet, lower case. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * `'b_' + base32(sha256(owner_id ␟ kind ␟ inner_path ␟ sibling_index))[0..12]`
 * (60 bits; ␟ = U+001F). `ownerId`: `notes.id` or `repository_files.id`;
 * `innerPath`: heading titles joined with ` > `, or `Class.method` for code;
 * `siblingIndex`: see `siblingIndexes`.
 */
export function blockId(ownerId: string, kind: BlockKind, innerPath: string, siblingIndex: number): string {
  const digest = createHash('sha256').update(`${ownerId}\u001f${kind}\u001f${innerPath}\u001f${siblingIndex}`).digest()
  let id = 'b_'
  // 12 characters of 5 bits from the first 8 bytes, most significant bit first.
  let bits = 0
  let value = 0
  for (let i = 0; id.length < 14; ) {
    if (bits < 5) {
      value = (value << 8) | digest[i++]!
      bits += 8
    }
    bits -= 5
    id += BASE32[(value >>> bits) & 31]
    value &= (1 << bits) - 1
  }
  return id
}

/**
 * Each block's 0-based index among the blocks with the same kind and inner
 * path, in document order: two `## Notes` sections, or two overloads of
 * `Store.save`, get 0 and 1.
 */
export function siblingIndexes(blocks: ReadonlyArray<{ kind: BlockKind; innerPath: string }>): number[] {
  const seen = new Map<string, number>()
  return blocks.map(({ kind, innerPath }) => {
    const key = `${kind}\u001f${innerPath}`
    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    return index
  })
}

export interface Heading {
  /** Offset of the heading line. */
  start: number
  /** Offset just past the heading line, its line break included. */
  end: number
  level: number
  line: string
  title: string
}

/** The level and text of an ATX heading line (`## Plan`, `## Plan ##`), or null. */
export function atxHeading(line: string): { level: number; title: string } | null {
  const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line)
  if (!atx) return null
  return { level: atx[1]!.length, title: (atx[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim() }
}

/** ATX headings (`#` to `######`) outside fenced code blocks. */
export function headings(text: string): Heading[] {
  const out: Heading[] = []
  let fence: string | null = null
  for (let start = 0; start < text.length; ) {
    const nl = text.indexOf('\n', start)
    const end = nl === -1 ? text.length : nl + 1
    const line = text.slice(start, nl === -1 ? text.length : nl).replace(/\r$/, '')
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === null && marker) fence = marker
    // A closing fence has no info string (CommonMark): "```js" inside a block is content.
    else if (fence !== null && marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null
    else if (fence === null) {
      const atx = atxHeading(line)
      if (atx) out.push({ start, end, ...atx, line: line.trim() })
    }
    start = end
  }
  return out
}
