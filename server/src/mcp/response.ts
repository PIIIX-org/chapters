import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * The response envelope of the budgeted MCP tools (#420, #422; ADR-004
 * §2.1). A budgeted tool takes `budget_tokens` and `cursor`; its handler
 * returns a `Budgeted` answer (a head of fixed fields plus sections), and
 * `tool()` renders it here, at the one serialisation point:
 *
 * - The answer stays within the budget, counted as `approxTokens`, what the
 *   premise benchmark counts. Lists drop whole items from the end, text is
 *   cut at a line boundary; nothing is cut without being counted. The one
 *   exception is an answer that would show nothing at all: it shows the
 *   first item (or line) anyway, so paging always moves on.
 * - Every answer ends with `truncated`: `false` when nothing was left out
 *   and there is no further page, else what each section showed, its total
 *   from where this page starts (`">n"` when the fetch of limit + 1 found
 *   more), what was dropped, the ladder level, a cursor and narrowing
 *   suggestions.
 * - A cursor continues with the same arguments only (an argument
 *   fingerprint), and refuses to continue content that changed under it (a
 *   guard: the text's hash, or the ids already shown of a ranking).
 *
 * The over-budget ladder (#421) and result handles (#423) build on this:
 * `level` is always `full` until the ladder lands.
 */

/** Tokens as the benchmark counts them: UTF-16 code units / 4, rounded up. */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4)

export type BudgetKind = 'list' | 'read'
export const DEFAULT_BUDGET: Record<BudgetKind, number> = { list: 2_000, read: 4_000 }
const MIN_BUDGET = 256
const MAX_BUDGET = 25_000

/** The arguments every budgeted tool takes, with its kind's default in the description. */
export function budgetArgs(kind: BudgetKind): z.ZodRawShape {
  return {
    budget_tokens: z
      .number()
      .int()
      .min(MIN_BUDGET)
      .max(MAX_BUDGET)
      .optional()
      .describe(`Answer size cap in tokens (chars/4); default ${DEFAULT_BUDGET[kind]}`),
    cursor: z.string().optional().describe('`truncated.cursor` of the previous answer, with the same arguments'),
  }
}

/** One ladder level per answer (#421); only `full` until the ladder lands. */
export type Level = 'full'

export type Truncated =
  | false
  | {
      shown: Record<string, number>
      total: Record<string, number | `>${number}`>
      dropped: Record<string, number>
      level: Level
      cursor: string | null
      narrow: string[]
    }

/** A position the next page resumes from (a path, an `ord`, an offset), or null: from the section's start. */
export type Resume = string | number | null

/**
 * A list a keyset cursor pages: `items` start where the cursor resumes (the
 * handler applies `Page.after`), and `resume` gives the position after an
 * item. `more`: the fetch of `limit` + 1 found an item after `items`.
 */
export interface KeysetSection<T> {
  name: string
  items: readonly T[]
  resume: (item: T, index: number) => string | number
  limit?: number
  more?: boolean
}

/**
 * A ranking an offset cursor pages: `items` is the whole ranking from its
 * first item (recomputed per page); the cursor holds the offset and a guard
 * over the `id`s before it, so a ranking that changed is refused, never
 * skipped or repeated. At most `limit` items per answer.
 */
export interface RankedSection<T> {
  name: string
  items: readonly T[]
  id: (item: T) => string
  limit?: number
}

/**
 * Text cut at line boundaries (a line longer than the budget is split). Its
 * shown/total/dropped count lines. `lines`: add `lines: [first, last]`
 * (1-based) to the answer when only part of the text is shown.
 */
export interface TextSection {
  name: string
  text: string
  lines?: boolean
}

export type Section =
  | ({ kind: 'keyset' } & KeysetSection<never>)
  | ({ kind: 'ranked' } & RankedSection<never>)
  | ({ kind: 'text' } & TextSection)

export const keyset = <T>(s: KeysetSection<T>): Section => ({ kind: 'keyset', ...(s as unknown as KeysetSection<never>) })
export const ranked = <T>(s: RankedSection<T>): Section => ({ kind: 'ranked', ...(s as unknown as RankedSection<never>) })
export const textSection = (s: TextSection): Section => ({ kind: 'text', ...s })

export interface Budgeted {
  /** Fields shown whole, before the sections. */
  head: Record<string, unknown>
  sections: Section[]
  /** Arguments that would narrow this answer, e.g. `path: "docs"`; shown when something was left out. */
  narrow?: string[]
  /** Runs after rendering with what was left out (read_note's last-read record, #864). */
  rendered?: (truncated: Truncated) => Promise<void>
}

/** A refused cursor; `code` is the ADR-004 §2.7 error code the error envelope (#439) will carry. */
export class CursorError extends Error {
  constructor(
    readonly code: 'CURSOR_INVALID' | 'CURSOR_STALE',
    message: string,
  ) {
    super(message)
  }
}

const invalid = (why: string) =>
  new CursorError('CURSOR_INVALID', `invalid cursor: ${why}; pass \`truncated.cursor\` with the arguments of the answer it came from`)

const CursorJson = z
  .object({
    v: z.literal(1),
    t: z.string(),
    f: z.string(),
    k: z.object({ s: z.number().int().min(0), p: z.union([z.string(), z.number(), z.null()]) }).strict(),
    g: z.string().optional(),
  })
  .strict()
type CursorJson = z.infer<typeof CursorJson>
export type CursorAt = CursorJson['k'] & { g?: string }

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    entries.sort(([a], [b]) => compareCodeUnits(a, b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Arguments a cursor is not bound to: the paging ones, and the ids the resolved scope stands for. */
const UNBOUND_ARGS: Record<string, true> = { cursor: true, budget_tokens: true, vaultId: true, repositoryId: true, everywhere: true }

/**
 * The arguments a cursor is bound to: every argument except `cursor` and
 * `budget_tokens` (a page may take another budget), with the ids the call
 * resolved to in place of the id arguments, so a pinned connection's
 * cursor works with and without its pin's id.
 */
export function argsFingerprint(args: Record<string, unknown>, scope: unknown): string {
  const bound = Object.fromEntries(Object.entries(args).filter(([key]) => !UNBOUND_ARGS[key]))
  return sha256(canonical({ ...bound, scope: args.everywhere === true ? 'everywhere' : scope })).slice(0, 16)
}

export function encodeCursor(json: CursorJson): string {
  return Buffer.from(JSON.stringify(json)).toString('base64url')
}

/** The position a cursor resumes `tool` at; refused when it is malformed or was issued for another tool or other arguments. */
export function decodeCursor(cursor: string, tool: string, fingerprint: string): CursorAt {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    json = undefined
  }
  const parsed = CursorJson.safeParse(json)
  if (!parsed.success) throw invalid('not a cursor this server issued')
  if (parsed.data.t !== tool) throw invalid(`issued by ${parsed.data.t}`)
  if (parsed.data.f !== fingerprint) throw invalid('issued for other arguments')
  return { ...parsed.data.k, ...(parsed.data.g === undefined ? {} : { g: parsed.data.g }) }
}

/** Where a budgeted handler's answer starts. */
export class Page {
  constructor(readonly at: CursorAt | null) {}

  /** The keyset position the cursor resumes section `section` after; null on its first page. */
  after<T extends string | number>(section: number, schema: z.ZodType<T>): T | null {
    if (this.at?.s !== section || this.at.p === null) return null
    const parsed = schema.safeParse(this.at.p)
    if (!parsed.success) throw invalid('not a position of this answer')
    return parsed.data
  }

  /** How many items of ranked section `section` earlier pages showed (0 on its first page): a handler fetches this many plus its limit + 1. */
  shownBefore(section: number): number {
    return this.at?.s === section && typeof this.at.p === 'number' ? this.at.p : 0
  }
}

/** Code-unit order: the same in JS and in Postgres `COLLATE "C"`, whatever the locale. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const guardOf = (value: string) => sha256(value).slice(0, 8)

/** `\n`s in `text` before `end`. */
function newlines(text: string, end = text.length): number {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** Lines in `text`: a final line without `\n` counts; an empty text has none. */
const countLines = (text: string) => (text === '' ? 0 : newlines(text) + (text.endsWith('\n') ? 0 : 1))

/** Characters `s` takes inside a JSON string. */
const escapedLength = (s: string) => JSON.stringify(s).length - 2

/** One section on this page: where it starts and what it can show. */
interface Slot {
  section: Section
  /** Items (keyset, ranked) or characters (text) earlier pages showed; -1: the cursor is past this section. */
  start: number
  /** Ranked and keyset sections: the items this page may show, in order. */
  avail: readonly unknown[]
  more: boolean
  limit: number
}

function slots(answer: Budgeted, at: CursorAt | null): Slot[] {
  const s0 = at?.s ?? 0
  if (s0 >= answer.sections.length) throw invalid('not a position of this answer')
  return answer.sections.map((section, i): Slot => {
    if (i < s0) return { section, start: -1, avail: [], more: false, limit: 0 }
    const here = at !== null && i === s0
    if (section.kind === 'keyset') {
      const limit = section.limit ?? Infinity
      return { section, start: 0, avail: section.items.slice(0, limit), more: section.more === true || section.items.length > limit, limit }
    }
    if (section.kind === 'ranked') {
      const start = here ? Number(at.p) : 0
      if (!Number.isSafeInteger(start) || start < 0) throw invalid('not a position of this answer')
      if (here && (start > section.items.length || at.g !== guardOf(section.items.slice(0, start).map(section.id).join('\n')))) {
        throw new CursorError('CURSOR_STALE', `stale cursor: the ${section.name} changed since this cursor was issued; start again without \`cursor\``)
      }
      const limit = section.limit ?? Infinity
      const rest = section.items.slice(start)
      return { section, start, avail: rest.slice(0, limit), more: rest.length > limit, limit }
    }
    const start = here ? Number(at.p) : 0
    if (!Number.isSafeInteger(start) || start < 0) throw invalid('not a position of this answer')
    if (here && (start > section.text.length || at.g !== guardOf(section.text))) {
      throw new CursorError('CURSOR_STALE', `stale cursor: the ${section.name} changed since this cursor was issued; start again without \`cursor\``)
    }
    return { section, start, avail: [], more: false, limit: Infinity }
  })
}

/** What one page shows of each section (an item count, or a text length in characters), and whether it is only the unit shown to move on. */
interface Fill {
  shown: number[]
  forced: boolean
}

/**
 * Fills sections in order within `room` characters of JSON beyond the
 * empty answer: whole items, whole lines; the first thing that does not fit
 * ends the page. A line longer than a whole page is split where the room
 * ends. When nothing at all fits, the first item or line is shown anyway
 * (`forced`; a line over the room left, at least 1,024 characters, is split
 * there), so a cursor always moves on.
 */
function fill(slots: Slot[], room: number, itemLength: (slot: number, i: number) => number): Fill {
  const shown = slots.map(() => 0)
  let used = 0
  let any = false
  for (const [n, slot] of slots.entries()) {
    if (slot.start < 0) continue
    if (slot.section.kind === 'text') {
      const { text } = slot.section
      let at = slot.start
      while (at < text.length) {
        const nl = text.indexOf('\n', at)
        const end = nl === -1 ? text.length : nl + 1
        const cost = escapedLength(text.slice(at, end))
        if (used + cost > room) {
          if (!any) {
            const left = Math.max(room - used, 1_024)
            shown[n] = (cost <= left ? end : splitLine(text, at, end, left)) - slot.start
            return { shown, forced: true }
          }
          // A line no page holds whole starts here, split at the room left; any other line starts the next page.
          if (cost > room && room - used > 0) at = splitLine(text, at, end, room - used)
          break
        }
        used += cost
        at = end
        any = true
      }
      shown[n] = at - slot.start
      if (at < text.length) return { shown, forced: false }
      continue
    }
    for (let i = 0; i < slot.avail.length; i++) {
      const cost = itemLength(n, i) + (i > 0 ? 1 : 0)
      if (used + cost > room) {
        if (any) return { shown, forced: false }
        shown[n] = 1
        return { shown, forced: true }
      }
      used += cost
      shown[n] = i + 1
      any = true
    }
    if (slot.more) return { shown, forced: false }
  }
  return { shown, forced: false }
}

/** The end of a split line's first part: at most `room` JSON characters, never inside a surrogate pair, at least one code point. */
function splitLine(text: string, from: number, end: number, room: number): number {
  let at = from
  let used = 0
  while (at < end) {
    const step = text.codePointAt(at)! > 0xffff ? 2 : 1
    const cost = escapedLength(text.slice(at, at + step))
    if (used + cost > room && at > from) break
    used += cost
    at += step
  }
  return at
}

/**
 * Renders a budgeted answer: `{...head, lines?, ...sections, truncated}`
 * within `budget` tokens. `at` is the cursor's position (null: first page).
 */
export function render(
  answer: Budgeted,
  ctx: { tool: string; fingerprint: string; budget: number; at: CursorAt | null },
): { text: string; truncated: Truncated } {
  const plan = slots(answer, ctx.at)
  const lengths = plan.map((slot) => new Array<number | undefined>(slot.avail.length))
  const itemLength = (n: number, i: number) => (lengths[n]![i] ??= JSON.stringify(plan[n]!.avail[i]).length)
  const maxChars = ctx.budget * 4
  const empty = compose(answer, plan, plan.map(() => 0), ctx).text.length
  // The truncated block grows with what is left out: refill with that much less room until the answer fits.
  let reserve = 0
  for (;;) {
    const { shown, forced } = fill(plan, maxChars - empty - reserve, itemLength)
    const out = compose(answer, plan, shown, ctx)
    if (out.text.length <= maxChars || forced) return out
    reserve += out.text.length - maxChars
  }
}

function compose(
  answer: Budgeted,
  plan: Slot[],
  shown: number[],
  ctx: { tool: string; fingerprint: string; at: CursorAt | null },
): { text: string; truncated: Truncated } {
  const out: Record<string, unknown> = { ...answer.head }
  const counts = { shown: {} as Record<string, number>, total: {} as Record<string, number | `>${number}`>, dropped: {} as Record<string, number> }
  let cursor: string | null = null
  let anyDropped = false
  const values: Array<[string, unknown]> = []
  for (const [n, slot] of plan.entries()) {
    const { section } = slot
    if (section.kind === 'text') {
      const chunk = slot.start < 0 ? '' : section.text.slice(slot.start, slot.start + shown[n]!)
      const rest = slot.start < 0 ? '' : section.text.slice(slot.start)
      const shownLines = countLines(chunk)
      const total = countLines(rest)
      values.push([section.name, chunk])
      counts.shown[section.name] = shownLines
      counts.total[section.name] = total
      counts.dropped[section.name] = total - shownLines
      const partial = slot.start > 0 || chunk.length < rest.length
      if (section.lines && partial && chunk !== '') {
        const first = newlines(section.text, slot.start) + 1
        out.lines = [first, first + shownLines - 1]
      }
      if (cursor === null && chunk.length < rest.length) {
        cursor = encodeCursor({ v: 1, t: ctx.tool, f: ctx.fingerprint, k: { s: n, p: slot.start + chunk.length }, g: guardOf(section.text) })
      }
      anyDropped ||= chunk.length < rest.length
      continue
    }
    const items = slot.avail.slice(0, shown[n])
    values.push([section.name, items])
    const exact = slot.start < 0 ? 0 : slot.avail.length
    counts.shown[section.name] = items.length
    counts.total[section.name] = slot.more ? `>${slot.limit === Infinity ? exact : slot.limit}` : exact
    counts.dropped[section.name] = exact - items.length
    anyDropped ||= exact > items.length
    if (cursor !== null || (exact === items.length && !slot.more) || slot.start < 0) continue
    if (section.kind === 'keyset') {
      const last = items.length - 1
      const p: Resume = last >= 0 ? section.resume(items[last] as never, last) : n === ctx.at?.s ? ctx.at.p : null
      cursor = encodeCursor({ v: 1, t: ctx.tool, f: ctx.fingerprint, k: { s: n, p } })
    } else {
      const p = slot.start + items.length
      cursor = encodeCursor({ v: 1, t: ctx.tool, f: ctx.fingerprint, k: { s: n, p }, g: guardOf(section.items.slice(0, p).map(section.id).join('\n')) })
    }
  }
  for (const [name, value] of values) out[name] = value
  const truncated: Truncated =
    cursor === null && !anyDropped ? false : { ...counts, level: 'full', cursor, narrow: answer.narrow ?? [] }
  out.truncated = truncated
  return { text: JSON.stringify(out), truncated }
}
