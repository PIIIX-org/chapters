// The re-reading scripted agent of the session benchmark (#683). It reads
// the way the skill tells agents to (skills/elara/SKILL.md, Step 1), so it
// asks for passages it already has, which is what `session_id` saves:
//
//   search(question) -> for each of the first FILES files of the ranking:
//     read_file outline: true -> the focus entries (the outline entries the
//     search's symbol hits fall in, else those whose name has a word of the
//     question) -> read_file targets: focus -> read_file targets: focus and
//     the sections next to each (the focus again, with its neighbours).
//   A file whose outline gives no focus is read whole (its first page).
//
// Unlike the premise policies (benchmarks/lib/policies.ts) there is no
// oracle stop: an agent does not know when it has the evidence, so every
// question runs the whole script (within the same caps) and the episode
// books tokens-to-gold on the way. The questions of one suite run in one
// session: they share files, as the questions of a real session do.
//
// The policy decides the same way in both modes. `sessionTools` adds the
// session's `session_id` to every read_file (search takes none); an answer
// by reference covers the lines it names (the agent has them from the call
// it names), and a referenced outline reads as the outline that call sent
// (`context`). `expandAnswer` puts the referenced text back, which is also
// how the runner checks that a session answer equals the plain one.
import { dedupe, type LineRange } from '../lib/metrics.ts'
import { CAPS, Episode, readFilePage, searchHits, visibleContentLines, type Caps, type ToolResponse } from '../lib/policies.ts'

/** Files of the search ranking the policy opens. */
export const FILES = 3
/** Outline entries read as the focus of one file. */
export const FOCUS = 3
/** read_file `targets` takes at most this many parts (server/src/mcp/read-targets.ts MAX_TARGETS). */
const MAX_TARGETS = 20

export interface ReadArgs {
  path: string
  outline?: true
  targets?: Array<{ lines: string }>
}

export interface SessionTools {
  /** MCP `search` {query, repositoryId, limit: 10}. */
  search(query: string): Promise<ToolResponse>
  /** MCP `read_file` {repositoryId, ...args}, plus the run's `session_id` in session mode. */
  readFile(args: ReadArgs): Promise<ToolResponse>
}

export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<ToolResponse>

/** The run's tools: the only difference between the modes is `session_id` on read_file. */
export function sessionTools(call: McpCall, repositoryId: string, searchLimit: number, sessionId: string | null): SessionTools {
  return {
    search: (query) => call('search', { query, repositoryId, limit: searchLimit }),
    readFile: (args) => call('read_file', { repositoryId, ...args, ...(sessionId === null ? {} : { session_id: sessionId }) }),
  }
}

/** One call of an episode as the agent got it, for the runner's comparison of the modes. */
export interface Answer {
  tool: 'search' | 'read_file'
  /** The call's arguments without the repository and the session (the same in both modes). */
  args: string
  /** The file a read_file read; null for search. */
  path: string | null
  text: string
}

export interface RereadRun {
  ranking: string[]
  episode: Episode
  answers: Answer[]
}

/** An outline entry as the policy uses it: its name (symbol, heading or block) and lines. */
export interface Entry {
  name: string
  start: number
  end: number
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function field(json: unknown, key: string): unknown {
  return json && typeof json === 'object' ? Reflect.get(json, key) : undefined
}

const LOC = /#L(\d+)(?:-L(\d+))?$/

/** Lines a..b a `path#La-Lb` location names. */
function locLines(loc: unknown): [number, number] | null {
  const m = typeof loc === 'string' ? LOC.exec(loc) : null
  if (!m) return null
  const a = Number(m[1])
  return [a, m[2] === undefined ? a : Number(m[2])]
}

function linePair(value: unknown): [number, number] | null {
  return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number' ? [value[0], value[1]] : null
}

/**
 * The entries of an outline answer: objects with `lines` (full and
 * no-context rungs of the ladder) or `name#La-Lb` locations; none at the
 * `counts` rung.
 */
export function outlineEntries(json: unknown): Entry[] {
  const outline = field(json, 'outline')
  if (!Array.isArray(outline)) return []
  return outline.flatMap((item: unknown): Entry[] => {
    if (typeof item === 'string') {
      const lines = locLines(item)
      return lines ? [{ name: item.replace(LOC, ''), start: lines[0], end: lines[1] }] : []
    }
    const lines = linePair(field(item, 'lines'))
    if (!lines) return []
    const name = [field(item, 'symbol'), field(item, 'heading'), field(item, 'block')].find((v) => typeof v === 'string') as string | undefined
    return [{ name: name ?? '', start: lines[0], end: lines[1] }]
  })
}

/**
 * The lines of `path` a read_file answer puts in context: its content page
 * and each `targets` part shown, or the lines a reference to an earlier
 * call names (the agent has them from that call). A part's last line counts
 * when its text ends it: not when the page split it (`next`).
 */
export function shownRanges(path: string, json: unknown): LineRange[] {
  const ranges: LineRange[] = []
  const content = field(json, 'content')
  if (typeof content === 'string') {
    const page = readFilePage(json)
    if (page && page.lines > 0) ranges.push({ path, start: page.first, end: page.first + page.lines - 1 })
  } else {
    const lines = locLines(field(field(content, 'same_as'), 'loc'))
    if (lines) ranges.push({ path, start: lines[0], end: lines[1] })
  }
  const parts = field(json, 'targets')
  for (const part of Array.isArray(parts) ? parts : []) {
    const lines = linePair(field(part, 'lines'))
    if (!lines) continue
    const text = field(part, 'text')
    if (typeof text === 'string') {
      const whole = text.split('\n').length - 1 + (text !== '' && !text.endsWith('\n') && field(part, 'next') === undefined ? 1 : 0)
      if (whole > 0) ranges.push({ path, start: lines[0], end: lines[0] + whole - 1 })
    } else if (field(part, 'same_as') !== undefined) {
      ranges.push({ path, start: lines[0], end: lines[1] })
    }
  }
  return ranges
}

const STOP = new Set(
  'about also and are does each file files from have how into its kept many more much only same some that the their then them there these they this those under what when where which while who why will with without exactly every'.split(
    ' ',
  ),
)

/** The words of a question an agent would look for in an outline: four letters or more, not a stop word. */
export function questionTerms(question: string): string[] {
  return dedupe(
    question
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  )
}

/**
 * The entries to read first: for each search symbol hit in this file (best
 * first), the smallest entry holding its first line; without one, the
 * entries whose name has the most question words (document order breaks
 * ties). At most `max`, in document order.
 */
export function focusEntries(entries: readonly Entry[], hits: readonly LineRange[], terms: readonly string[], max = FOCUS): Entry[] {
  const chosen: Entry[] = []
  for (const hit of hits) {
    const holding = entries.filter((e) => e.start <= hit.start && e.end >= hit.start).sort((a, b) => a.end - a.start - (b.end - b.start))[0]
    if (holding && !chosen.includes(holding)) chosen.push(holding)
  }
  if (chosen.length === 0) {
    const scored = entries
      .map((e, i) => ({ e, i, score: terms.filter((t) => e.name.toLowerCase().includes(t)).length }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
    chosen.push(...scored.map((s) => s.e))
  }
  return chosen.slice(0, max).sort((a, b) => a.start - b.start || b.end - a.end)
}

/** The focus entries with the section before and after each: the closest entry ending above it and the first starting below it. */
export function withNeighbours(entries: readonly Entry[], focus: readonly Entry[]): Entry[] {
  const out: Entry[] = []
  const add = (e: Entry | undefined) => {
    if (e && !out.some((o) => o.start === e.start && o.end === e.end)) out.push(e)
  }
  for (const f of focus) {
    add(entries.filter((e) => e.end < f.start).sort((a, b) => b.end - a.end || b.start - a.start)[0])
    add(f)
    add(entries.filter((e) => e.start > f.end).sort((a, b) => a.start - b.start)[0])
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end).slice(0, MAX_TARGETS)
}

const targetsOf = (entries: readonly Entry[]) => entries.map((e) => ({ lines: `${e.start}-${e.end}` }))

/** The lines a search symbol hit shows: its first lines as the snippet (as runElara counts them). */
function symbolHitLines(hit: { path?: unknown; resourceType?: unknown; startLine?: unknown; endLine?: unknown; snippet?: unknown }): LineRange | null {
  if (hit.resourceType !== 'symbol' || typeof hit.path !== 'string') return null
  if (typeof hit.startLine !== 'number' || typeof hit.endLine !== 'number' || typeof hit.snippet !== 'string') return null
  return { path: hit.path, start: hit.startLine, end: Math.min(hit.endLine, hit.startLine + hit.snippet.split('\n').length - 1) }
}

/**
 * One question. `context` is what the agent's session holds: each session
 * answer by its `call`, filled here and shared by the questions of a suite,
 * so a reference (an outline the session already got) reads as what it
 * names. Without a session no answer has a `call` and it stays empty.
 */
export async function runReread(
  question: string,
  gold: readonly LineRange[],
  tools: SessionTools,
  caps: Caps = CAPS,
  context: Map<number, unknown> = new Map(),
): Promise<RereadRun> {
  const ep = new Episode(gold, caps)
  const answers: Answer[] = []
  const spent = () => ep.trace.length >= caps.maxCalls || ep.tokens >= caps.tokenBudget

  const res = await tools.search(question)
  const parsed = res.ok ? parseJson(res.text) : undefined
  const hits = searchHits(parsed)
  const shown = hits.map(symbolHitLines).filter((r): r is LineRange => r !== null)
  const cut = ep.clip(res.text)
  ep.record('search', question, cut.visible, cut.truncated, res.ms, res.ok, shown)
  answers.push({ tool: 'search', args: JSON.stringify({ query: question }), path: null, text: res.text })
  const ranking = dedupe(hits.map((h) => h.path).filter((p): p is string => typeof p === 'string'))

  /** One read_file, booked; its answer with references expanded (undefined when it failed or the agent saw it cut). */
  const read = async (args: ReadArgs, label: string): Promise<unknown> => {
    const r = await tools.readFile(args)
    const view = ep.clip(r.text)
    const json = r.ok ? parseJson(r.text) : undefined
    let ranges: LineRange[] = []
    if (json !== undefined && !view.truncated) ranges = shownRanges(args.path, json)
    else if (json !== undefined) {
      // Cut by the harness (perCallChars): only the content lines still shown whole count.
      const page = readFilePage(json)
      const lines = page ? visibleContentLines(r.text, page.content, caps.perCallChars) : 0
      if (page && lines > 0) ranges = [{ path: args.path, start: page.first, end: page.first + lines - 1 }]
    }
    ep.record('read_file', label, view.visible, view.truncated, r.ms, r.ok, ranges)
    answers.push({ tool: 'read_file', args: JSON.stringify(args), path: args.path, text: r.text })
    if (view.truncated || json === undefined) return undefined
    const call = field(json, 'call')
    if (typeof call === 'number') context.set(call, json)
    return expandAnswer(json, context) ?? json
  }

  const terms = questionTerms(question)
  for (const path of ranking.slice(0, Math.min(FILES, caps.maxFiles))) {
    if (spent()) break
    const entries = outlineEntries(await read({ path, outline: true }, `${path} outline`))
    const focus = focusEntries(
      entries,
      shown.filter((r) => r.path === path),
      terms,
    )
    if (spent()) break
    if (focus.length === 0) {
      await read({ path }, path)
      continue
    }
    await read({ path, targets: targetsOf(focus) }, `${path} targets ${targetsOf(focus).map((t) => t.lines).join(',')}`)
    if (spent()) break
    const around = withNeighbours(entries, focus)
    await read({ path, targets: targetsOf(around) }, `${path} targets ${targetsOf(around).map((t) => t.lines).join(',')}`)
  }
  return { ranking, episode: ep, answers }
}

// ---- Comparing the modes ------------------------------------------------------

interface Ref {
  call: number
  loc: string
}

function refOf(value: unknown): Ref | null {
  const same = field(value, 'same_as')
  const call = field(same, 'call')
  const loc = field(same, 'loc')
  return typeof call === 'number' && typeof loc === 'string' ? { call, loc } : null
}

/** The text call `ref.call` of the session sent of the lines `ref.loc` names, or null when it sent none. */
function referenced(sent: ReadonlyMap<number, unknown>, ref: Ref): string | null {
  const answer = sent.get(ref.call)
  const lines = locLines(ref.loc)
  if (answer === undefined || !lines) return null
  const [a, b] = lines
  const pieces: Array<[number, string]> = []
  const content = field(answer, 'content')
  if (typeof content === 'string') pieces.push([linePair(field(answer, 'lines'))?.[0] ?? 1, content])
  const parts = field(answer, 'targets')
  for (const part of Array.isArray(parts) ? parts : []) {
    const text = field(part, 'text')
    const at = linePair(field(part, 'lines'))
    if (typeof text === 'string' && at) pieces.push([at[0], text])
  }
  const piece = pieces.find(([first, text]) => first <= a && first + text.split(/(?<=\n)/).length - 1 >= b)
  // Lines a..b of the piece, each with its newline.
  return piece
    ? piece[1]
        .split(/(?<=\n)/)
        .slice(a - piece[0], b - piece[0] + 1)
        .join('')
    : null
}

/**
 * A session answer with every reference replaced by what it names and
 * without its `call`: what the same read answers without `session_id`.
 * `sent` maps a session call to its answer. Null when a reference names
 * text the session never got.
 */
export function expandAnswer(json: unknown, sent: ReadonlyMap<number, unknown>): unknown {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return json
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(json)) {
    if (key === 'call') continue
    const ref = refOf(value)
    if (!ref) out[key] = value
    else if (key === 'outline' || key === 'symbols') out[key] = field(sent.get(ref.call), key)
    else {
      const text = referenced(sent, ref)
      if (text === null) return null
      out[key] = text
    }
    if (out[key] === undefined) return null
  }
  if (Array.isArray(out.targets)) {
    const parts: unknown[] = []
    for (const part of out.targets) {
      const ref = refOf(part)
      if (!ref) {
        parts.push(part)
        continue
      }
      const text = referenced(sent, ref)
      if (text === null) return null
      parts.push(Object.fromEntries(Object.entries(part as Record<string, unknown>).map(([k, v]) => (k === 'same_as' ? ['text', text] : [k, v]))))
    }
    out.targets = parts
  }
  return out
}

/** An answer for comparison: a cursor names the same position in both modes, but a session one also carries the referenced sections (`r`). */
export function comparable(json: unknown): string {
  return JSON.stringify(json).replace(/"cursor":"[^"]*"/g, '"cursor":"…"')
}
