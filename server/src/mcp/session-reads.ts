/**
 * Session reads (#683, ADR-004 §2.1, §2.9 D7): read_note and read_file
 * under the caller's `session_id` send a passage the session already got as
 * a reference, `same_as: {call, loc, rev | hash}`, instead of its text.
 *
 * - Passages: each text with lines (a body page, read_file's content, each
 *   `targets` part), the outline and read_file's symbol list.
 * - A text passage repeats when the session got the same document version
 *   with lines covering it (`loc` names those lines, the version is this
 *   answer's), or the same text of the document at any version (`loc` names
 *   the lines it had then, and the version is that call's). A list repeats
 *   when the session got the same list (`loc` is the path). A changed passage
 *   has another hash, so it is sent in full.
 * - A reference is used only when it is shorter than the text it replaces.
 * - A cursor page continues an answer already started, so it is sent in
 *   full; what it shows is remembered like any other page.
 * - Every session answer names its `call`; what a page showed whole is
 *   remembered after it is rendered (response.ts `Seen`). Without
 *   `session_id` nothing here runs: the answer is the one dev sent before.
 */
import { z } from 'zod'
import { passageHash, rememberPassages, type HeldPassage, type PassageKind, type Session } from '../cache/session.js'
import { lineStarts, totalLines } from '../text/lines.js'
import { wholeLines, type LineRange } from '../text/targets.js'
import { location, type Budgeted, type CursorAt, type Section } from './response.js'

/**
 * The `session_id` argument: the agent's own id for its context (8-64
 * characters), checked here and listed without bounds (tools/list pays for
 * every keyword). Its description is all the reader's tools/list says of it
 * (the reader budget, #429): the skill and elara://manual/conventions say
 * when to send one and that omitting it answers in full.
 */
export const SESSION_ARG = z
  .string()
  .refine((s) => s.length >= 8 && s.length <= 64, { error: 'session_id is 8 to 64 characters' })
  .optional()
  .describe('Yours; repeats come as `same_as`')

/** The document a read answers (the session was opened on its id): its path, version as answers name it, and its text in the numbering of the answer's lines. */
export interface SessionDocument {
  path: string
  /** A note's `rev`; a file's content `hash` (16 hex, without the `~pending` of an index that lags it). */
  version: { rev: number } | { hash: string }
  text: string
}

const LISTS: Record<string, PassageKind> = { outline: 'outline', symbols: 'symbols' }

/**
 * `answer` as `session` sends it: its head names the `call`, repeated
 * passages are references (on a first page), and what the page shows whole
 * is remembered once it is rendered. Without a session, `answer` itself.
 */
export function inSession(session: Session | null, doc: SessionDocument, answer: Budgeted, at: CursorAt | null): Budgeted {
  if (!session) return answer
  const [versionKey, current] = 'rev' in doc.version ? (['rev', doc.version.rev] as const) : (['hash', doc.version.hash] as const)
  const version = String(current)
  // Line starts are computed once, when a passage is first checked or remembered.
  let starts: number[] | undefined
  const linesOf = ([a, b]: LineRange) => wholeLines(doc.text, a, b, (starts ??= lineStarts(doc.text)))
  const sameAs = (held: HeldPassage, loc: string) => ({ call: held.call, loc, [versionKey]: versionKey === 'rev' ? Number(held.version) : held.version })

  /** The reference that replaces a passage of `length` characters, or null to send it. */
  const repeated = (kind: PassageKind, hash: string, lines: LineRange | null, length: number) => {
    const covering = lines && session.held.find((h) => h.kind === 'text' && h.version === version && h.first <= lines[0] && h.last >= lines[1])
    const same = covering ? undefined : session.held.find((h) => h.kind === kind && h.hash === hash)
    const ref = covering
      ? sameAs(covering, location(doc.path, lines[0], lines[1]))
      : same && sameAs(same, kind === 'text' ? location(doc.path, same.first, same.last) : doc.path)
    return ref && JSON.stringify({ same_as: ref }).length < length ? ref : null
  }

  const sections = answer.sections.map((section): Section => {
    if (at !== null || section.kind === 'keyset') return section
    if (section.kind === 'ranked') {
      const kind = LISTS[section.name]
      if (!kind || section.items.length === 0) return section
      const items = JSON.stringify(section.items)
      const ref = repeated(kind, passageHash(kind, items), null, items.length)
      return ref ? { ...section, ref: { same_as: ref } } : section
    }
    if (!section.lines || section.withheld || section.text === '') return section
    const first = section.firstLine ?? 1
    const lines: LineRange = [first, first + totalLines(section.text) - 1]
    const ref = repeated('text', passageHash('text', linesOf(lines)), lines, section.text.length)
    if (!ref) return section
    return { ...section, ref: section.part ? { lines, same_as: ref } : { same_as: ref } }
  })

  return {
    ...answer,
    head: { ...answer.head, call: session.call },
    sections,
    rendered: async (truncated, seen) => {
      await answer.rendered?.(truncated, seen)
      const passages: Array<Omit<HeldPassage, 'call'>> = []
      for (const [n, section] of sections.entries()) {
        const shown = seen[n]
        if (section.kind === 'text' && Array.isArray(shown)) {
          const [first, last] = shown as LineRange
          passages.push({ kind: 'text', hash: passageHash('text', linesOf([first, last])), version, first, last })
        } else if (section.kind === 'ranked' && shown === true && LISTS[section.name] && section.items.length > 0) {
          const kind = LISTS[section.name]!
          passages.push({ kind, hash: passageHash(kind, JSON.stringify(section.items)), version, first: 0, last: 0 })
        }
      }
      await rememberPassages(session, passages)
    },
  }
}
