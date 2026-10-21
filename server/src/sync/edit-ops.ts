import { isDeepStrictEqual } from 'node:util'
import { assertLengthFits } from '../notes/size-cap.js'

/**
 * `edit_note` ops (#408): local changes an agent asks for instead of sending
 * the whole body back. Body ops resolve against the note's live text when the
 * edit is applied (crdt-write.ts runs them inside the document transaction),
 * so text a person typed since the agent last read the note is kept. Ops run
 * in order, each on the result of the previous one; if any op cannot be
 * resolved (an anchor missing or found more than once) the whole edit is
 * refused and nothing changes. Frontmatter ops apply on top of #438's merge.
 * The size cap (#491) is checked on each op's result length before that
 * result is built, so a huge `replace` repeated many times is refused with
 * the size error instead of building a string of hundreds of megabytes.
 */

/** Contradictory or unresolvable edit arguments (#438, #408). 400 over REST. */
export class NoteEditError extends Error {
  readonly statusCode = 400
}

export type EditOp =
  | { op: 'replace_text'; find: string; replace: string; expectedCount?: number }
  | { op: 'insert_before' | 'insert_after'; anchor: string; text: string }
  | { op: 'replace_section'; heading: string; content: string }
  | { op: 'append' | 'prepend'; text: string }
  | { op: 'delete_block'; find: string }
  | { op: 'frontmatter_set' | 'frontmatter_add'; key: string; value: unknown }
  | { op: 'frontmatter_remove'; key: string; value?: unknown }

type FrontmatterOp = Extract<EditOp, { op: `frontmatter_${string}` }>

export function isFrontmatterOp(op: EditOp): op is FrontmatterOp {
  return op.op.startsWith('frontmatter_')
}

/** A searched string as an error shows it: quoted, long ones cut. */
function quoted(text: string): string {
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text)
}

/** How many times `needle` occurs in `text`, overlapping occurrences included (`aa` occurs twice in `aaa`), and the first offset. */
function occurrences(text: string, needle: string): { count: number; separate: number; first: number } {
  const first = text.indexOf(needle)
  let count = 0
  // Occurrences that do not overlap an earlier one, left to right: what `replaceAll` replaces.
  let separate = 0
  let free = 0
  for (let i = first; i !== -1; i = text.indexOf(needle, i + 1)) {
    count++
    if (i >= free) {
      separate++
      free = i + needle.length
    }
  }
  return { count, separate, first }
}

/** A lone surrogate (half of a UTF-16 pair, valid in JSON) would split a pair in the text, which Yjs stores as U+FFFD. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

/** Refuses an empty searched string or one holding half a surrogate pair. */
function checkNeedle(needle: string, what: string, where: string): void {
  if (needle === '') throw new NoteEditError(`${where}: \`${what}\` is empty`)
  if (LONE_SURROGATE.test(needle)) throw new NoteEditError(`${where}: \`${what}\` holds half of a UTF-16 surrogate pair`)
}

/** Where `needle` occurs exactly once; anything else is refused. */
function uniqueAt(text: string, needle: string, what: string, where: string): number {
  checkNeedle(needle, what, where)
  const found = occurrences(text, needle)
  if (found.count === 0) throw new NoteEditError(`${where}: ${quoted(needle)} not found in the note`)
  if (found.count > 1) {
    throw new NoteEditError(`${where}: ${quoted(needle)} occurs ${found.count} times; give a longer \`${what}\` that occurs once`)
  }
  return found.first
}

interface Heading {
  /** Offset of the heading line. */
  start: number
  /** Offset just past the heading line, its line break included. */
  end: number
  level: number
  line: string
  title: string
}

/** The level and text of an ATX heading line (`## Plan`, `## Plan ##`), or null. */
function atxHeading(line: string): { level: number; title: string } | null {
  const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line)
  if (!atx) return null
  return { level: atx[1]!.length, title: (atx[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim() }
}

/** ATX headings (`#` to `######`) outside fenced code blocks. */
function headings(text: string): Heading[] {
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

/**
 * `text` with the section under `heading` replaced by `content` (subsections
 * included). `fits` gets the result's length before the result is built.
 */
function replaceSection(text: string, heading: string, content: string, where: string, fits: (length: number) => void): string {
  const wanted = heading.trim()
  if (wanted === '') throw new NoteEditError(`${where}: \`heading\` is empty`)
  const all = headings(text)
  // `## Plan` names the level and text (closing `#`s aside); `Plan` names the text at any level.
  const asLine = wanted.startsWith('#') ? atxHeading(wanted) : null
  const matches = all.filter((h) => (asLine ? h.level === asLine.level && h.title === asLine.title : h.title === wanted))
  if (matches.length === 0) {
    const known = all.slice(0, 20).map((h) => quoted(h.line))
    throw new NoteEditError(`${where}: heading ${quoted(wanted)} not found in the note${known.length ? `; its headings: ${known.join(', ')}` : ''}`)
  }
  if (matches.length > 1) {
    throw new NoteEditError(
      `${where}: heading ${quoted(wanted)} occurs ${matches.length} times${wanted.startsWith('#') ? '' : '; give the whole heading line, e.g. "## Title"'}`,
    )
  }
  const target = matches[0]!
  const next = all.find((h) => h.start > target.start && h.level <= target.level)
  const sectionEnd = next ? next.start : text.length
  const trimmed = content.replace(/^\n+/, '').replace(/\n+$/, '')
  // A blank line after the heading and before the next one, as markdown is usually written.
  const lead = text[target.end - 1] === '\n' ? '' : '\n'
  const section = trimmed === '' ? (next ? '\n' : '') : `\n${trimmed}\n${next ? '\n' : ''}`
  fits(target.end + lead.length + section.length + text.length - sectionEnd)
  return `${text.slice(0, target.end)}${lead}${section}${text.slice(sectionEnd)}`
}

/**
 * `body` after the body ops in `ops`, in order; frontmatter ops are skipped
 * (an error's `ops[i]` is the index in `ops`). Throws NoteEditError, or
 * NoteTooLargeError when an op's result would exceed the size cap against
 * `stored`, the note's stored body (#491), before that result is built.
 */
export function applyBodyOps(body: string, ops: readonly EditOp[], stored: string = body): string {
  let text = body
  ops.forEach((op, index) => {
    const where = `ops[${index}] ${op.op}`
    const fits = (length: number): void => assertLengthFits(length, stored, where)
    switch (op.op) {
      case 'replace_text': {
        checkNeedle(op.find, 'find', where)
        const expected = op.expectedCount ?? 1
        const found = occurrences(text, op.find)
        if (found.count === 0) throw new NoteEditError(`${where}: ${quoted(op.find)} not found in the note`)
        if (found.separate !== found.count) {
          throw new NoteEditError(`${where}: occurrences of ${quoted(op.find)} overlap; give a longer \`find\` whose occurrences are apart`)
        }
        if (found.count !== expected) {
          throw new NoteEditError(`${where}: ${quoted(op.find)} occurs ${found.count} times, expectedCount is ${expected}; nothing was changed`)
        }
        fits(text.length + found.count * (op.replace.length - op.find.length))
        // A replacer function: `$&` and friends in `replace` stay literal.
        text = text.replaceAll(op.find, () => op.replace)
        break
      }
      case 'insert_before':
      case 'insert_after': {
        const at = uniqueAt(text, op.anchor, 'anchor', where) + (op.op === 'insert_after' ? op.anchor.length : 0)
        fits(text.length + op.text.length)
        text = `${text.slice(0, at)}${op.text}${text.slice(at)}`
        break
      }
      case 'replace_section':
        text = replaceSection(text, op.heading, op.content, where, fits)
        break
      case 'append':
      case 'prepend': {
        // The text as whole lines: it starts and ends a line of its own.
        const added = op.text.endsWith('\n') ? op.text : `${op.text}\n`
        const lineBreak = op.op === 'append' && text !== '' && !text.endsWith('\n') ? 1 : 0
        fits(text.length + lineBreak + added.length)
        if (op.op === 'prepend') text = `${added}${text}`
        else text = `${text === '' || text.endsWith('\n') ? text : `${text}\n`}${added}`
        break
      }
      case 'delete_block': {
        const at = uniqueAt(text, op.find, 'find', where)
        let end = at + op.find.length
        // A whole line found without its line break takes the line break with it.
        if ((at === 0 || text[at - 1] === '\n') && !op.find.endsWith('\n') && text[end] === '\n') end++
        text = `${text.slice(0, at)}${text.slice(end)}`
        break
      }
      default:
        break
    }
  })
  return text
}

/**
 * `frontmatter` after the frontmatter ops in `ops`, in order: `frontmatter_set`
 * sets a key, `frontmatter_add` adds a value to a list (creating it, skipping a
 * value already there), `frontmatter_remove` deletes a key or, with `value`,
 * removes that value from a list. Throws NoteEditError.
 */
export function applyFrontmatterOps(frontmatter: Record<string, unknown>, ops: readonly EditOp[]): Record<string, unknown> {
  const next = { ...frontmatter }
  ops.forEach((op, index) => {
    if (!isFrontmatterOp(op)) return
    const where = `ops[${index}] ${op.op}`
    if (op.key === '') throw new NoteEditError(`${where}: \`key\` is empty`)
    if (op.key === 'type') throw new NoteEditError(`${where}: \`type\` is the note's folder; rename or move the note to change it`)
    const current = next[op.key]
    const list = (): unknown[] => {
      if (Array.isArray(current)) return current
      throw new NoteEditError(`${where}: frontmatter "${op.key}" is not a list; use frontmatter_set`)
    }
    switch (op.op) {
      case 'frontmatter_set':
        next[op.key] = op.value
        break
      case 'frontmatter_add':
        if (current === undefined) next[op.key] = [op.value]
        else if (!list().some((item) => isDeepStrictEqual(item, op.value))) next[op.key] = [...list(), op.value]
        break
      case 'frontmatter_remove':
        if (op.value === undefined) delete next[op.key]
        else if (current !== undefined) next[op.key] = list().filter((item) => !isDeepStrictEqual(item, op.value))
        break
    }
  })
  return next
}
