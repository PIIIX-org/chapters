import { createHash } from 'node:crypto'
import { z } from 'zod'
import { totalLines } from '../text/lines.js'

/**
 * The response envelope of the budgeted MCP tools (#420, #422; ADR-004
 * §2.1). A budgeted tool takes `budget_tokens` and `cursor`; its handler
 * returns a `Budgeted` answer (a head of fixed fields plus sections), and
 * `tool()` renders it here, at the one serialisation point:
 *
 * - The answer stays within the budget, counted as `approxTokens`, what the
 *   premise benchmark counts, over every text block it is sent in. Lists
 *   drop whole items from the end, text is cut at a line boundary; nothing
 *   is cut without being counted. A text that would show nothing at all
 *   shows its first line anyway (split when longer than the page), so
 *   paging always moves on.
 * - A `block` text (read_note's body, #445) is not a JSON string: it is sent
 *   unescaped as its own text block after the JSON, whose key holds
 *   `{"in": "content[n]"}` in its place, and counted by its characters.
 * - The ladder (#421): when a list would show fewer than `MIN_ITEMS` (or
 *   fewer than are left) even on a page of its own, every list on the page
 *   steps down one level, `full` → `no_context` → `locations` → `counts` →
 *   `total`, until it fits. A level no list on the page defines is skipped.
 *   Text is never laddered: it pages by lines.
 * - Every answer ends with `truncated`: `false` when nothing was left out
 *   and there is no further page, else what each section showed, its total
 *   from where this page starts (`">n"` when the fetch of limit + 1 found
 *   more), what was dropped, the ladder level, a cursor and narrowing
 *   suggestions (below `full`, first the budget that shows `full`).
 * - A cursor continues with the same arguments only (an argument
 *   fingerprint), and refuses to continue content that changed under it (a
 *   guard: the text's hash, or the ids already shown of a ranking).
 *
 * Result handles (#423) build on this.
 */

/** Tokens as the benchmark counts them: UTF-16 code units / 4, rounded up. */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4)

export type BudgetKind = 'list' | 'read'
export const DEFAULT_BUDGET: Record<BudgetKind, number> = { list: 2_000, read: 4_000 }
const MIN_BUDGET = 256
const MAX_BUDGET = 25_000

/**
 * The arguments every budgeted tool takes, with its kind's default in the
 * description. What a token is, the budget's range and how the cursor is
 * used are said once, in `initialize.instructions` (#435, instructions.ts):
 * the range is checked here but not listed as `minimum`/`maximum`, which
 * every budgeted tool would repeat in tools/list (#416 made room for read
 * targets in the reader budget so).
 */
export function budgetArgs(kind: BudgetKind): z.ZodRawShape {
  return {
    // `.int()` would list JS's safe-integer bounds as `minimum`/`maximum`: the integer check is in the refinement.
    budget_tokens: z
      .number()
      .refine((n) => Number.isInteger(n) && n >= MIN_BUDGET && n <= MAX_BUDGET, { error: `budget_tokens is an integer from ${MIN_BUDGET} to ${MAX_BUDGET}` })
      .optional()
      .describe(`Default ${DEFAULT_BUDGET[kind]}`),
    cursor: z.string().optional().describe('Next page'),
  }
}

/**
 * The ladder's levels (#421), from whole items down. `full`, `no_context`
 * and `locations` show items (whole, without context, a location only) and
 * page with the cursor; `counts` shows each list as `{group: n}` and
 * `total` as `n`, over the items from where the page starts; the lists
 * issue no cursor (the same budget would show the same counts again), but
 * a text before them that did not fit still continues with its cursor.
 */
export type Level = 'full' | 'no_context' | 'locations' | 'counts' | 'total'

/**
 * How a list's items step down the ladder. `no_context`: the item without
 * its context (snippets, frontmatter, timestamps); `locations`: its
 * location only (a path, `path#La-Lb`, an id); a missing form falls back to
 * the level above. `group`: the key `counts` counts an item under (its
 * folder, file or kind), `weight` how much it counts (default 1); without
 * `group`, `counts` shows the list's total.
 */
export interface Ladder<T> {
  no_context?: (item: T) => unknown
  locations?: (item: T) => unknown
  group?: (item: T) => string
  weight?: (item: T) => number
}

/** Fewer items than this (or than are left) on a page of their own: the list steps down a level. */
export const MIN_ITEMS = 5

/** A line range as a location string (ADR-004 §2.2): `path#La-Lb`, or `path#La` for one line. */
export const location = (path: string, first: number, last: number): string =>
  first === last ? `${path}#L${first}` : `${path}#L${first}-L${last}`

/** The folder `counts` groups a path under: its directory, or `.` at the root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '.' : path.slice(0, slash)
}

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
  ladder?: Ladder<T>
}

/**
 * A ranking an offset cursor pages: `items` is the whole ranking from its
 * first item (recomputed per page); the cursor holds the offset and a guard
 * over the `id`s before it, so a ranking that changed is refused, never
 * skipped or repeated. `limit` bounds the whole ranking: pages walk its first
 * `limit` items, and an item past them (a limit + 1 fetch) only sets `">limit"`:
 * the answer is not whole, but no cursor continues past it (a larger limit
 * does), and the page goes on to the sections after this one.
 */
export interface RankedSection<T> {
  name: string
  items: readonly T[]
  id: (item: T) => string
  limit?: number
  ladder?: Ladder<T>
  /** No items: the answer has no key for it (a read's outline outside outline mode, #417). */
  omitEmpty?: boolean
}

/**
 * Text cut at line boundaries (a line longer than the budget is split). Its
 * shown/total/dropped count lines. `lines`: add `lines: [first, last]` to
 * the answer when only part of the text is shown, numbered from
 * `firstLine` (default 1; a note body's `body_start_line`, ADR-004 §2.2 D3).
 * `block`: send this page's text as a text block of its own after the JSON
 * (#445), on every page, empty or not.
 *
 * `withheld` (#417): the page shows none of it, counts all of it as
 * dropped, and its cursor starts it (a read that answers its outline).
 *
 * `part` (#416): the text is one item of the list `name`, which the parts
 * of that name make in order (one per read target): shown as `{...part,
 * lines: [a, b], text, next?}` numbered from `firstLine`, where `next: "a-b"`
 * names the lines of the part this page did not show; a part the page does
 * not reach is `{...part, next}`, and one an earlier page finished is left
 * out. With `lines` false a part has no text and is shown as it is (a
 * target's error).
 */
export interface TextSection {
  name: string
  text: string
  lines?: boolean
  block?: boolean
  firstLine?: number
  withheld?: boolean
  part?: Record<string, unknown>
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

/** A refused cursor; `code` is the error envelope's code (#439, ADR-004 §2.7). */
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
}

/** Code-unit order: the same in JS and in Postgres `COLLATE "C"`, whatever the locale. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const guardOf = (value: string) => sha256(value).slice(0, 8)

/**
 * The guard of a ranked section's cursor at `p`: the ids before it, and the text of every text section before
 * the ranked one, so a symbols-only `read_file` page is refused once the file changed under it.
 */
function rankedGuard(sections: readonly Section[], n: number, p: number): string {
  const section = sections[n]!
  if (section.kind !== 'ranked') throw new Error(`section ${section.name} is not ranked`)
  const texts = sections.slice(0, n).flatMap((s) => (s.kind === 'text' ? [s.text] : []))
  return guardOf([...texts, section.items.slice(0, p).map(section.id).join('\n')].join('\0'))
}

/** `\n`s in `text` before `end`. */
function newlines(text: string, end = text.length): number {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** Characters `s` takes inside a JSON string. */
const escapedLength = (s: string) => JSON.stringify(s).length - 2
/** Characters `s` takes as a text block of its own. */
const rawLength = (s: string) => s.length

/** One section on this page: where it starts and what it can show. */
interface Slot {
  section: Section
  /** Items (keyset, ranked) or characters (text) earlier pages showed; -1: the cursor is past this section. */
  start: number
  /** Ranked and keyset sections: the items this page may show, in order. */
  avail: readonly unknown[]
  /** More items than `avail`: a keyset section's next page, or a ranked section's items past its `limit` (no page). */
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
      const start = here ? (typeof at.p === 'number' ? at.p : NaN) : 0
      if (!Number.isSafeInteger(start) || start < 0) throw invalid('not a position of this answer')
      if (here && (start > section.items.length || at.g !== rankedGuard(answer.sections, i, start))) {
        throw new CursorError('CURSOR_STALE', `stale cursor: the ${section.name} changed since this cursor was issued; start again without \`cursor\``)
      }
      const limit = section.limit ?? Infinity
      // `limit` bounds the ranking as a whole, not each page: pages walk its first `limit` items, and the
      // lookahead item past them (a limit + 1 fetch) only says that more exist.
      return { section, start, avail: section.items.slice(start, limit), more: section.items.length > limit, limit }
    }
    const start = here ? (typeof at.p === 'number' ? at.p : NaN) : 0
    if (!Number.isSafeInteger(start) || start < 0) throw invalid('not a position of this answer')
    if (here && (start > section.text.length || at.g !== guardOf(section.text))) {
      throw new CursorError('CURSOR_STALE', `stale cursor: the ${section.name} changed since this cursor was issued; start again without \`cursor\``)
    }
    return { section, start, avail: [], more: false, limit: Infinity }
  })
}

/**
 * What one page shows of each section (an item count, or a text length in
 * characters), whether it is only the unit shown to move on, and the
 * section the page stopped in (-1: it showed everything).
 */
interface Fill {
  shown: number[]
  forced: boolean
  stop: number
}

/**
 * Fills sections in order within `room` characters of JSON beyond the
 * empty answer: whole items, whole lines; the first thing that does not fit
 * ends the page. A line longer than a whole page is split where the room
 * ends. When nothing at all fits, the first item or line is shown anyway
 * (`forced`; a line over the room left, at least 1,024 characters, is split
 * there). `aggregate` (the `counts` and `total` levels): lists are counted,
 * not filled (their counts are in the empty answer), and text after a list
 * shows nothing.
 */
function fill(slots: Slot[], room: number, itemLength: (slot: number, i: number) => number, aggregate: boolean): Fill {
  const shown = slots.map(() => 0)
  let used = 0
  let any = false
  let counted = false
  for (const [n, slot] of slots.entries()) {
    if (slot.start < 0 || (slot.section.kind === 'text' && slot.section.withheld)) continue
    if (slot.section.kind === 'text') {
      if (counted) continue
      const { text } = slot.section
      const length = slot.section.block ? rawLength : escapedLength
      let at = slot.start
      while (at < text.length) {
        const nl = text.indexOf('\n', at)
        const end = nl === -1 ? text.length : nl + 1
        const cost = length(text.slice(at, end))
        if (used + cost > room) {
          if (!any) {
            const left = Math.max(room - used, 1_024)
            shown[n] = (cost <= left ? end : splitLine(text, at, end, left, length)) - slot.start
            return { shown, forced: true, stop: n }
          }
          // A line no page holds whole starts here, split at the room left; any other line starts the next page.
          if (cost > room && room - used > 0) at = splitLine(text, at, end, room - used, length)
          break
        }
        used += cost
        at = end
        any = true
      }
      shown[n] = at - slot.start
      if (at < text.length) return { shown, forced: false, stop: n }
      continue
    }
    if (aggregate) {
      counted = true
      continue
    }
    for (let i = 0; i < slot.avail.length; i++) {
      const cost = itemLength(n, i) + (i > 0 ? 1 : 0)
      if (used + cost > room) {
        if (any) return { shown, forced: false, stop: n }
        shown[n] = 1
        return { shown, forced: true, stop: n }
      }
      used += cost
      shown[n] = i + 1
      any = true
    }
    // A keyset list's next page starts here; past a ranked list's `limit` there is no page, so the next section fills on.
    if (slot.more && slot.section.kind === 'keyset') return { shown, forced: false, stop: n }
  }
  return { shown, forced: false, stop: -1 }
}

/** The end of a split line's first part: at most `room` characters (as `length` counts them), never inside a surrogate pair, at least one code point. */
function splitLine(text: string, from: number, end: number, room: number, length: (s: string) => number): number {
  let at = from
  let used = 0
  while (at < end) {
    const step = text.codePointAt(at)! > 0xffff ? 2 : 1
    const cost = length(text.slice(at, at + step))
    if (used + cost > room && at > from) break
    used += cost
    at += step
  }
  return at
}

/** How a list shows its items at an item level: the ladder's form, the level above's, or the item itself. */
function formOf(section: Section, level: Level): ((item: never) => unknown) | undefined {
  if (section.kind === 'text') return undefined
  if (level === 'no_context') return section.ladder?.no_context
  if (level === 'locations') return section.ladder?.locations ?? section.ladder?.no_context
  return undefined
}

/** A list at `counts` (`{group: n}`, keys in code-unit order) or `total` (`n`), over the items from the page start. */
function aggregateOf(slot: Slot, level: 'counts' | 'total'): unknown {
  const ladder = slot.section.kind === 'text' ? undefined : slot.section.ladder
  if (level === 'total' || !ladder?.group) return slot.avail.length
  const counts = new Map<string, number>()
  for (const item of slot.avail as never[]) {
    const key = ladder.group(item)
    counts.set(key, (counts.get(key) ?? 0) + (ladder.weight?.(item) ?? 1))
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => compareCodeUnits(a, b)))
}

interface Rendering {
  tool: string
  fingerprint: string
  at: CursorAt | null
  level: Level
  narrow: string[]
}

/** A `block` text section's text on this page, sent as its own text block after the JSON (#445). */
export interface Block {
  name: string
  text: string
}

/** A rendered answer: the JSON text, the blocks after it in order, and what was left out. */
export interface Rendered {
  text: string
  blocks: Block[]
  truncated: Truncated
}

/**
 * The characters a rendered answer takes: the JSON, and each block after it
 * plus one for the separator between text blocks. The premise benchmark
 * (the lab client's `text`) joins the blocks with a newline, so the budget
 * and the benchmark count the same characters.
 */
const charsOf = (r: Rendered) => r.blocks.reduce((n, block) => n + 1 + block.text.length, r.text.length)

/**
 * Renders a budgeted answer: `{...head, lines?, ...sections, truncated}`
 * within `budget` tokens. `at` is the cursor's position (null: first page).
 *
 * Levels are tried from `full` down. An item level is kept when the page
 * fits and either did not stop in a list, or that list could show at least
 * `min(MIN_ITEMS, items left)` items at this level on a page of its own: so
 * whole items are dropped first, and a list that an earlier section crowded
 * out starts the next page instead. `counts` is kept when it fits; `total`
 * always is (the one answer that can exceed the budget: a head larger than
 * the budget).
 */
export function render(
  answer: Budgeted,
  ctx: { tool: string; fingerprint: string; budget: number; at: CursorAt | null },
): Rendered {
  const plan = slots(answer, ctx.at)
  const maxChars = ctx.budget * 4
  const lists = plan.filter((slot) => slot.start >= 0 && slot.section.kind !== 'text')
  const levels: Level[] = ['full']
  if (lists.some((slot) => formOf(slot.section, 'no_context'))) levels.push('no_context')
  if (lists.some((slot) => formOf(slot.section, 'locations') && formOf(slot.section, 'locations') !== formOf(slot.section, 'no_context'))) {
    levels.push('locations')
  }
  if (lists.some((slot) => slot.avail.length > 0)) levels.push('counts', 'total')
  let narrow = answer.narrow ?? []
  let out: Rendered | undefined
  for (const level of levels) {
    const forms = plan.map((slot) => formOf(slot.section, level))
    const lengths = plan.map((slot) => new Array<number | undefined>(slot.avail.length))
    const itemLength = (n: number, i: number) => {
      const item = plan[n]!.avail[i] as never
      return (lengths[n]![i] ??= JSON.stringify(forms[n] ? forms[n](item) : item).length)
    }
    const rendering: Rendering = { ...ctx, level, narrow }
    const aggregate = level === 'counts' || level === 'total'
    const empty = charsOf(compose(answer, plan, plan.map(() => 0), rendering))
    // The truncated block grows with what is left out: refill with that much less room until the answer fits.
    // Nothing shown is as small as the answer gets: a head over the budget (a huge frontmatter over an empty
    // body) is answered as it is.
    let reserve = 0
    let page: Fill
    for (;;) {
      page = fill(plan, maxChars - empty - reserve, itemLength, aggregate)
      out = compose(answer, plan, page.shown, rendering)
      if (charsOf(out) <= maxChars || page.forced || page.shown.every((n) => n === 0)) break
      reserve += charsOf(out) - maxChars
    }
    const fits = charsOf(out) <= maxChars
    if (level === 'total' || (level === 'counts' && fits)) return out
    if (aggregate) continue
    const stop = plan[page.stop]
    if (!stop || stop.section.kind === 'text') return out
    if (fits) {
      // The list the page stopped in, on a page of its own at this level.
      const alone = plan.map((slot, n) => (n === page.stop ? slot : { ...slot, start: -1 }))
      const solo = fill(alone, maxChars - empty - reserve, itemLength, false)
      if (!solo.forced && solo.shown[page.stop]! >= Math.min(MIN_ITEMS, stop.avail.length)) return out
    }
    if (level === 'full') {
      // Below full, `narrow` first names the budget that shows this page's list at full.
      const shown = page.shown.map((n, i) => (i === page.stop ? Math.min(MIN_ITEMS, stop.avail.length) : i < page.stop ? n : 0))
      const needed = Math.ceil(Math.ceil(charsOf(compose(answer, plan, shown, rendering)) / 4) / 50) * 50 + 50
      if (needed <= MAX_BUDGET) narrow = [`budget_tokens: ${needed}`, ...narrow]
    }
  }
  return out!
}

function compose(answer: Budgeted, plan: Slot[], shown: number[], ctx: Rendering): Rendered {
  const out: Record<string, unknown> = { ...answer.head }
  const counts = { shown: {} as Record<string, number>, total: {} as Record<string, number | `>${number}`>, dropped: {} as Record<string, number> }
  const aggregate = ctx.level === 'counts' || ctx.level === 'total' ? ctx.level : null
  let cursor: string | null = null
  let anyDropped = false
  // At counts and total: a list on this page was counted, so nothing after it is shown or continued.
  let counted = false
  let anyMore = false
  // A withheld text (a read answering its outline, #417) puts the page at `locations`.
  let withheld = false
  const values: Array<[string, unknown]> = []
  const parts = new Map<string, unknown[]>()
  const blocks: Block[] = []
  for (const [n, slot] of plan.entries()) {
    const { section } = slot
    if (section.kind === 'text') {
      if (slot.start < 0 && (section.part || section.withheld)) continue
      if (section.withheld) {
        const total = totalLines(section.text)
        counts.shown[section.name] = 0
        counts.total[section.name] = total
        counts.dropped[section.name] = total
        if (cursor === null && total > 0) cursor = encodeCursor({ v: 1, t: ctx.tool, f: ctx.fingerprint, k: { s: n, p: 0 }, g: guardOf(section.text) })
        anyDropped ||= total > 0
        withheld = true
        continue
      }
      const chunk = slot.start < 0 || counted ? '' : section.text.slice(slot.start, slot.start + shown[n]!)
      const rest = slot.start < 0 ? '' : section.text.slice(slot.start)
      // A line counts as shown on the page where it ends, so a line split across pages counts once.
      const shownLines = chunk.length < rest.length ? newlines(chunk) : totalLines(chunk)
      const total = totalLines(rest)
      // The first line this page shows (or would), in the document's numbering.
      const first = (section.firstLine ?? 1) + newlines(section.text, slot.start)
      if (section.part) {
        let list = parts.get(section.name)
        if (!list) {
          list = []
          parts.set(section.name, list)
          values.push([section.name, list])
        }
        const last = (section.firstLine ?? 1) + totalLines(section.text) - 1
        if (!section.lines) list.push(section.part)
        else if (chunk === '') list.push({ ...section.part, next: `${first}-${last}` })
        else {
          const to = first + totalLines(chunk) - 1
          // A line split across pages goes on from where this page cut it.
          const next = chunk.length < rest.length ? { next: `${chunk.endsWith('\n') ? to + 1 : to}-${last}` } : {}
          list.push({ ...section.part, lines: [first, to], text: chunk, ...next })
        }
        counts.shown[section.name] = (counts.shown[section.name] ?? 0) + shownLines
        const before = counts.total[section.name]
        counts.total[section.name] = (typeof before === 'number' ? before : 0) + total
        counts.dropped[section.name] = (counts.dropped[section.name] ?? 0) + total - shownLines
      } else {
        if (section.block) {
          // content[0] is the JSON, so the blocks after it are content[1], content[2], ...
          values.push([section.name, { in: `content[${blocks.length + 1}]` }])
          blocks.push({ name: section.name, text: chunk })
        } else {
          values.push([section.name, chunk])
        }
        counts.shown[section.name] = shownLines
        counts.total[section.name] = total
        counts.dropped[section.name] = total - shownLines
        const partial = slot.start > 0 || chunk.length < rest.length
        // The lines this page touches, a split one included.
        if (section.lines && partial && chunk !== '') out.lines = [first, first + totalLines(chunk) - 1]
      }
      if (cursor === null && !counted && chunk.length < rest.length) {
        cursor = encodeCursor({ v: 1, t: ctx.tool, f: ctx.fingerprint, k: { s: n, p: slot.start + chunk.length }, g: guardOf(section.text) })
      }
      anyDropped ||= chunk.length < rest.length
      continue
    }
    if (section.kind === 'ranked' && section.omitEmpty && section.items.length === 0) continue
    const exact = slot.start < 0 ? 0 : slot.avail.length
    counts.total[section.name] = slot.more ? `>${exact}` : exact
    if (aggregate && slot.start >= 0) {
      values.push([section.name, aggregateOf(slot, aggregate)])
      counts.shown[section.name] = 0
      counts.dropped[section.name] = exact
      anyDropped ||= exact > 0 || slot.more
      counted = true
      continue
    }
    const items = slot.avail.slice(0, shown[n])
    const form = formOf(section, ctx.level)
    values.push([section.name, form ? items.map((item) => form(item as never)) : items])
    counts.shown[section.name] = items.length
    counts.dropped[section.name] = exact - items.length
    anyDropped ||= exact > items.length
    anyMore ||= slot.start >= 0 && slot.more
    // Past a ranked section's `limit` there is no page: a larger `limit` shows more.
    if (cursor !== null || (exact === items.length && (!slot.more || section.kind === 'ranked')) || slot.start < 0) continue
    if (section.kind === 'keyset') {
      const last = items.length - 1
      const p: Resume = last >= 0 ? section.resume(items[last] as never, last) : n === ctx.at?.s ? ctx.at.p : null
      cursor = encodeCursor({ v: 1, t: ctx.tool, f: ctx.fingerprint, k: { s: n, p } })
    } else {
      const p = slot.start + items.length
      cursor = encodeCursor({ v: 1, t: ctx.tool, f: ctx.fingerprint, k: { s: n, p }, g: rankedGuard(answer.sections, n, p) })
    }
  }
  for (const [name, value] of values) out[name] = value
  // Below full every item lost its context or more, so the answer is never whole.
  const whole = cursor === null && !anyDropped && !anyMore && ctx.level === 'full'
  const truncated: Truncated = whole ? false : { ...counts, level: withheld && ctx.level === 'full' ? 'locations' : ctx.level, cursor, narrow: ctx.narrow }
  out.truncated = truncated
  return { text: JSON.stringify(out), blocks, truncated }
}
