import { isDeepStrictEqual } from 'node:util'

/**
 * `edit_note` ops (#408): local changes an agent asks for instead of sending
 * the whole body back. Body ops resolve against the note's live text when the
 * edit is applied (crdt-write.ts runs them inside the document transaction),
 * so text a person typed since the agent last read the note is kept. Ops run
 * in order, each on the result of the previous one; if any op cannot be
 * resolved (an anchor missing or found more than once) the whole edit is
 * refused and nothing changes. Frontmatter ops apply on top of #438's merge.
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

/** Start offsets of the non-overlapping occurrences of `needle`, left to right. */
function occurrences(text: string, needle: string): number[] {
  const found: number[] = []
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) found.push(i)
  return found
}

/** Where `needle` occurs exactly once; anything else is refused. */
function uniqueAt(text: string, needle: string, what: string, where: string): number {
  if (needle === '') throw new NoteEditError(`${where}: \`${what}\` is empty`)
  const found = occurrences(text, needle)
  if (found.length === 0) throw new NoteEditError(`${where}: ${quoted(needle)} not found in the note`)
  if (found.length > 1) {
    throw new NoteEditError(`${where}: ${quoted(needle)} occurs ${found.length} times; give a longer \`${what}\` that occurs once`)
  }
  return found[0]!
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

/** ATX headings (`#` to `######`) outside fenced code blocks. */
function headings(text: string): Heading[] {
  const out: Heading[] = []
  let fence: string | null = null
  for (let start = 0; start < text.length; ) {
    const nl = text.indexOf('\n', start)
    const end = nl === -1 ? text.length : nl + 1
    const line = text.slice(start, nl === -1 ? text.length : nl).replace(/\r$/, '')
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === null ? marker : null
    } else if (fence === null) {
      const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line)
      if (atx) {
        const title = (atx[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim()
        out.push({ start, end, level: atx[1]!.length, line: line.trim(), title })
      }
    }
    start = end
  }
  return out
}

/** `text` with the section under `heading` replaced by `content` (subsections included). */
function replaceSection(text: string, heading: string, content: string, where: string): string {
  const wanted = heading.trim()
  if (wanted === '') throw new NoteEditError(`${where}: \`heading\` is empty`)
  const all = headings(text)
  // `## Plan` names the heading line; `Plan` names its text at any level.
  const matches = all.filter((h) => (wanted.startsWith('#') ? h.line.replace(/[ \t]+/g, ' ') === wanted.replace(/[ \t]+/g, ' ') : h.title === wanted))
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
  return `${text.slice(0, target.end)}${lead}${section}${text.slice(sectionEnd)}`
}

/** `body` after the body ops in `ops`, in order; frontmatter ops are skipped. Throws NoteEditError. */
export function applyBodyOps(body: string, ops: readonly EditOp[]): string {
  let text = body
  ops.forEach((op, index) => {
    const where = `ops[${index}] ${op.op}`
    switch (op.op) {
      case 'replace_text': {
        if (op.find === '') throw new NoteEditError(`${where}: \`find\` is empty`)
        const expected = op.expectedCount ?? 1
        const found = occurrences(text, op.find).length
        if (found === 0) throw new NoteEditError(`${where}: ${quoted(op.find)} not found in the note`)
        if (found !== expected) {
          throw new NoteEditError(`${where}: ${quoted(op.find)} occurs ${found} times, expectedCount is ${expected}; nothing was changed`)
        }
        // A replacer function: `$&` and friends in `replace` stay literal.
        text = text.replaceAll(op.find, () => op.replace)
        break
      }
      case 'insert_before':
      case 'insert_after': {
        const at = uniqueAt(text, op.anchor, 'anchor', where) + (op.op === 'insert_after' ? op.anchor.length : 0)
        text = `${text.slice(0, at)}${op.text}${text.slice(at)}`
        break
      }
      case 'replace_section':
        text = replaceSection(text, op.heading, op.content, where)
        break
      case 'append':
      case 'prepend': {
        // The text as whole lines: it starts and ends a line of its own.
        const added = op.text.endsWith('\n') ? op.text : `${op.text}\n`
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
