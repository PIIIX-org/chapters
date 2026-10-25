// The two scripted "agents" of the premise benchmark. No language model:
// each policy is a fixed procedure, so a run is deterministic up to the
// index Elara builds. Both stop as soon as every gold range has been in
// their context (an oracle stop, the same for both), or when a cap is hit.
//
//   elara  search(question) -> read_file of each hit, best first: a file
//          that fits the default 4,000-token budget whole; for a larger one
//          its outline (#417), then one `targets` read (#416) of the
//          sections the question names and of the file's symbol hits,
//          then, if the gold is still unseen, its pages from the outline's
//          cursor
//   grep   rg --count (files ranked by matching lines) -> rg -n over the
//          top files (first matches of each) -> ranged reads around them
//
// Tools are injected, so the policies are unit-tested with fakes; the
// runner (benchmarks/run.ts) passes MCP calls and real ripgrep.
import { dedupe, estimateTokens, LineSet, type LineRange } from './metrics.ts'

export interface Caps {
  /** Calls per question (the first ranking call included). */
  maxCalls: number
  /** No new call once this many tokens have been received. */
  tokenBudget: number
  /** A response is cut to this many characters (what an agent harness shows). */
  perCallChars: number
  /** Files of the first ranking a policy may open. */
  maxFiles: number
}

export const CAPS: Caps = { maxCalls: 15, tokenBudget: 40_000, perCallChars: 100_000, maxFiles: 10 }

/** What a question costs when its gold is never reached: the most an episode can spend. */
export function missCost(caps: Caps): { tokens: number; calls: number } {
  return { tokens: caps.tokenBudget + Math.ceil(caps.perCallChars / 4), calls: caps.maxCalls }
}

/**
 * Grep policy: files listed by `rg --count`; files and matching lines per
 * file shown by the `rg -n` call; characters per shown line; ranged-read
 * window around a match; ranged reads per file.
 */
export const GREP = { listLines: 50, previewFiles: 10, matchesPerFile: 5, lineChars: 200, readBefore: 10, readAfter: 30, readsPerFile: 2 }

export interface CallTrace {
  tool: string
  arg: string
  tokens: number
  truncated: boolean
  ms: number
  ok: boolean
}

/** Cost and coverage bookkeeping of one policy on one question. */
export class Episode {
  readonly seen = new LineSet()
  readonly trace: CallTrace[] = []
  tokens = 0
  ms = 0
  tokensToGold: number | null = null
  callsToGold: number | null = null
  tokensToAllGold: number | null = null

  readonly gold: readonly LineRange[]
  readonly caps: Caps

  constructor(gold: readonly LineRange[], caps: Caps) {
    this.gold = gold
    this.caps = caps
  }

  /** The part of a response the agent gets to see. */
  clip(text: string): { visible: string; truncated: boolean } {
    return text.length > this.caps.perCallChars
      ? { visible: text.slice(0, this.caps.perCallChars), truncated: true }
      : { visible: text, truncated: false }
  }

  /** Books one call: its visible text, its time and the line ranges it put in context. */
  record(tool: string, arg: string, visible: string, truncated: boolean, ms: number, ok: boolean, ranges: readonly LineRange[]): void {
    const tokens = estimateTokens(visible)
    this.tokens += tokens
    this.ms += ms
    this.trace.push({ tool, arg, tokens, truncated, ms: Math.round(ms), ok })
    for (const r of ranges) this.seen.add(r.path, r.start, r.end)
    if (this.tokensToGold === null && this.gold.some((g) => this.seen.covers(g))) {
      this.tokensToGold = this.tokens
      this.callsToGold = this.trace.length
    }
    if (this.tokensToAllGold === null && this.allGold) this.tokensToAllGold = this.tokens
  }

  get allGold(): boolean {
    return this.gold.every((g) => this.seen.covers(g))
  }

  get done(): boolean {
    return this.allGold || this.trace.length >= this.caps.maxCalls || this.tokens >= this.caps.tokenBudget
  }
}

export interface ToolResponse {
  text: string
  ms: number
  ok: boolean
}

export interface PolicyRun {
  /** Distinct files of the policy's ranking call, best first (at most what the agent saw). */
  ranking: string[]
  episode: Episode
}

// ---- Elara -----------------------------------------------------------------

export interface ElaraTools {
  /** MCP `search` {query, repositoryId, limit: 10}. */
  search(query: string): Promise<ToolResponse>
  /** MCP `read_file` {repositoryId, path, cursor?, targets?}: the file whole, a page of it, its outline, or the parts `targets` names. */
  readFile(path: string, cursor?: string, targets?: ReadonlyArray<{ lines: string }>): Promise<ToolResponse>
}

interface SearchHit {
  path?: unknown
  resourceType?: unknown
  startLine?: unknown
  endLine?: unknown
  snippet?: unknown
  score?: unknown
}

/**
 * The hits of a `search` answer (#441, #442, #458): `results` of the
 * `{status, retrieval_mode, degraded, index?, results, truncated}` envelope,
 * in the server's order (score, then path, then id). Down the budget's
 * ladder a hit is its location string, `path` or `path#La-Lb`; at `counts`
 * and `total` there are no hits to read.
 */
export function searchHits(answer: unknown): SearchHit[] {
  const results: unknown = answer && typeof answer === 'object' ? Reflect.get(answer, 'results') : undefined
  if (!Array.isArray(results)) return []
  return results.flatMap((hit: unknown): SearchHit[] => {
    if (typeof hit === 'string') return [{ path: hit.replace(/#L\d+(-L\d+)?$/, '') }]
    return hit && typeof hit === 'object' ? [hit as SearchHit] : []
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Lines a search hit shows: a symbol hit carries its line range and the
 * first lines of its code as the snippet. Code (file) hits carry a keyword
 * headline with no line numbers, so they show no addressable line.
 */
function symbolLines(hit: SearchHit): LineRange | null {
  if (hit.resourceType !== 'symbol' || typeof hit.path !== 'string') return null
  if (typeof hit.startLine !== 'number' || typeof hit.endLine !== 'number' || typeof hit.snippet !== 'string') return null
  const shown = hit.snippet.split('\n').length
  return { path: hit.path, start: hit.startLine, end: Math.min(hit.endLine, hit.startLine + shown - 1) }
}

/**
 * How many lines of `content` a `read_file` response cut at `visibleChars`
 * still shows in full. The response is compact JSON, so the content starts
 * after `"content":"` and every character is JSON-escaped.
 */
export function visibleContentLines(response: string, content: string, visibleChars: number): number {
  const at = response.indexOf('"content":"')
  if (at < 0) return 0
  let offset = at + '"content":"'.length
  let lines = 0
  for (const line of content.split('\n')) {
    offset += JSON.stringify(line).length - 2 + 2 // escaped line + the escaped "\n"
    if (offset > visibleChars) break
    lines++
  }
  return lines
}

/**
 * One `read_file` page (#420, #422): its content, the file line it starts
 * at (`lines[0]` when the file is paged), the lines it completes (a line
 * split across pages counts on the page where it ends) and the cursor of
 * the next page, if any.
 */
export function readFilePage(json: unknown): { content: string; first: number; lines: number; cursor?: string } | null {
  if (!json || typeof json !== 'object') return null
  const content: unknown = Reflect.get(json, 'content')
  if (typeof content !== 'string') return null
  const range: unknown = Reflect.get(json, 'lines')
  const first = Array.isArray(range) && typeof range[0] === 'number' ? range[0] : 1
  const truncated: unknown = Reflect.get(json, 'truncated')
  const next: unknown = truncated && typeof truncated === 'object' ? Reflect.get(truncated, 'cursor') : undefined
  const cursor = typeof next === 'string' ? next : undefined
  const newlines = content.split('\n').length - 1
  const last = cursor === undefined && content !== '' && !content.endsWith('\n') ? 1 : 0
  return { content, first, lines: newlines + last, ...(cursor === undefined ? {} : { cursor }) }
}

/** `truncated.cursor` of an answer, if it has one. */
function nextCursor(json: unknown): string | undefined {
  const truncated: unknown = json && typeof json === 'object' ? Reflect.get(json, 'truncated') : undefined
  const next: unknown = truncated && typeof truncated === 'object' ? Reflect.get(truncated, 'cursor') : undefined
  return typeof next === 'string' ? next : undefined
}

export interface OutlineEntry {
  /** The section's heading path or the symbol's `Class.method`; '' for a note's preamble. */
  name: string
  lines: [number, number]
  tokens: number
}

/** The `outline` of a `read_file` answer (#417): a file over the budget, as its headings or symbols with their lines. */
export function readFileOutline(json: unknown): OutlineEntry[] | null {
  const outline: unknown = json && typeof json === 'object' ? Reflect.get(json, 'outline') : undefined
  if (!Array.isArray(outline)) return null
  return outline.flatMap((e: unknown): OutlineEntry[] => {
    if (!e || typeof e !== 'object') return []
    const lines: unknown = Reflect.get(e, 'lines')
    if (!Array.isArray(lines) || typeof lines[0] !== 'number' || typeof lines[1] !== 'number') return []
    const name: unknown = Reflect.get(e, 'symbol') ?? Reflect.get(e, 'heading') ?? ''
    const tokens: unknown = Reflect.get(e, 'tokens')
    return [{ name: typeof name === 'string' ? name : '', lines: [lines[0], lines[1]], tokens: typeof tokens === 'number' ? tokens : 0 }]
  })
}

/**
 * The lines a `targets` read (#416) showed: each part's `lines`, the last
 * one only when it ends there (a line split across pages counts on the page
 * where it ends).
 */
export function targetLines(json: unknown, path: string): LineRange[] {
  const parts: unknown = json && typeof json === 'object' ? Reflect.get(json, 'targets') : undefined
  if (!Array.isArray(parts)) return []
  return parts.flatMap((part: unknown): LineRange[] => {
    if (!part || typeof part !== 'object') return []
    const lines: unknown = Reflect.get(part, 'lines')
    const text: unknown = Reflect.get(part, 'text')
    if (!Array.isArray(lines) || typeof lines[0] !== 'number' || typeof lines[1] !== 'number' || typeof text !== 'string') return []
    const split = Reflect.get(part, 'next') !== undefined && !text.endsWith('\n')
    const end = split ? lines[1] - 1 : lines[1]
    return end >= lines[0] ? [{ path, start: lines[0], end }] : []
  })
}

/** Words too common in questions to name a section. */
const STOP_WORDS = new Set(
  'and are for from how into its not that the then this what when where which who why with does did use used uses using file files code defined define implemented implement there their they them get set'.split(' '),
)

/** The words of a question or a name: identifiers split at case changes and non-letters, lower-cased, 3+ characters, no stop words. */
export function words(text: string): Set<string> {
  const split = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  return new Set(
    split
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  )
}

/** Two words name the same thing: equal, or (4+ characters) one starts the other (`embed`, `embedding`). */
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)))

/**
 * What the agent reads of `path` once it answered its outline: the outline
 * entries holding the file's symbol hits from the search, then those whose
 * names share the most words with the question (ties in file order); none
 * inside another or already seen, at most `ELARA.targetsPerFile` and
 * `ELARA.targetTokens` together, so a miss costs little more than the
 * outline before the agent pages the file as it would have.
 */
export function sectionTargets(
  question: string,
  path: string,
  outline: readonly OutlineEntry[],
  symbolHits: readonly LineRange[],
  seen: LineSet,
): Array<{ lines: string }> {
  const asked = [...words(question)]
  const chosen: OutlineEntry[] = []
  let tokens = 0
  const add = (entry: OutlineEntry) => {
    const [start, end] = entry.lines
    if (chosen.length >= ELARA.targetsPerFile || tokens + entry.tokens > ELARA.targetTokens) return
    if (chosen.some((c) => start >= c.lines[0] && end <= c.lines[1]) || seen.covers({ path, start, end })) return
    chosen.push(entry)
    tokens += entry.tokens
  }
  // The innermost entry holding each symbol hit's first line.
  for (const hit of symbolHits) {
    const holding = outline.filter((e) => e.lines[0] <= hit.start && hit.start <= e.lines[1]).sort((a, b) => a.lines[1] - a.lines[0] - (b.lines[1] - b.lines[0]))[0]
    if (holding) add(holding)
  }
  const scored = outline
    .map((entry, order) => {
      const named = [...words(entry.name)]
      return { entry, order, score: asked.filter((q) => named.some((n) => sameWord(q, n))).length }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
  for (const { entry } of scored) add(entry)
  return chosen.map((e) => ({ lines: `${e.lines[0]}-${e.lines[1]}` }))
}

/** Elara policy: parts, and their tokens together, one `targets` read asks for (one call, its cursor not followed). */
export const ELARA = { targetsPerFile: 2, targetTokens: 1_500 }

/** Lines a symbol hit spans, whole (search's `startLine`/`endLine`): what a targets read of it shows. */
function symbolSpan(hit: SearchHit): LineRange | null {
  if (hit.resourceType !== 'symbol' || typeof hit.path !== 'string' || typeof hit.startLine !== 'number' || typeof hit.endLine !== 'number') return null
  return { path: hit.path, start: hit.startLine, end: hit.endLine }
}

/** One `targets` read of `path`: within ELARA.targetTokens it fits the default budget, so its cursor is not followed. */
async function readTargets(ep: Episode, tools: ElaraTools, path: string, targets: ReadonlyArray<{ lines: string }>): Promise<void> {
  if (ep.done) return
  const res = await tools.readFile(path, undefined, targets)
  const cut = ep.clip(res.text)
  ep.record('read_file', `${path} targets`, cut.visible, cut.truncated, res.ms, res.ok, cut.truncated || !res.ok ? [] : targetLines(parseJson(res.text), path))
}

export async function runElara(question: string, gold: readonly LineRange[], tools: ElaraTools, caps: Caps = CAPS): Promise<PolicyRun> {
  const ep = new Episode(gold, caps)
  const res = await tools.search(question)
  const { visible, truncated } = ep.clip(res.text)
  const parsed = res.ok ? parseJson(res.text) : undefined
  const hits = searchHits(parsed)
  const ranges = hits.map(symbolLines).filter((r): r is LineRange => r !== null)
  ep.record('search', question, visible, truncated, res.ms, res.ok, ranges)
  const ranking = dedupe(hits.map((h) => h.path).filter((p): p is string => typeof p === 'string'))

  for (const path of ranking.slice(0, caps.maxFiles)) {
    // A long file comes in pages (#420): follow `truncated.cursor` until the gold is seen or the file ends. One over
    // the budget answers its outline first (#417): read what the question names (#416), then page it if still needed.
    let cursor: string | undefined
    let opened = false
    do {
      if (ep.done) break
      const file = await tools.readFile(path, cursor)
      const cut = ep.clip(file.text)
      const json = file.ok ? parseJson(file.text) : undefined
      const page = readFilePage(json)
      const lines = page ? (cut.truncated ? visibleContentLines(file.text, page.content, caps.perCallChars) : page.lines) : 0
      ep.record('read_file', path, cut.visible, cut.truncated, file.ms, file.ok, page && lines > 0 ? [{ path, start: page.first, end: page.first + lines - 1 }] : [])
      cursor = cut.truncated ? undefined : nextCursor(json)
      const outline = opened || cut.truncated ? null : readFileOutline(json)
      opened = true
      if (outline) {
        const spans = hits.map(symbolSpan).filter((r): r is LineRange => r !== null && r.path === path)
        const targets = sectionTargets(question, path, outline, spans, ep.seen)
        if (targets.length > 0) await readTargets(ep, tools, path, targets)
      }
    } while (cursor)
  }
  return { ranking, episode: ep }
}

// ---- grep ------------------------------------------------------------------

export interface GrepTools {
  /** Files with matching lines and their counts (`rg --count`), any order. */
  count(patterns: readonly string[]): Promise<{ files: Array<{ path: string; count: number }>; ms: number }>
  /** The first `perFile` matching lines of each file (`rg -n -m <perFile> ... -- <paths>`), ascending per file. */
  matches(
    patterns: readonly string[],
    paths: readonly string[],
    perFile: number,
  ): Promise<{ byPath: Map<string, Array<{ line: number; text: string }>>; ms: number }>
  /** Lines start..end of a file (clamped to its length), like an agent's ranged read. */
  read(path: string, start: number, end: number): Promise<{ lines: string[]; start: number; ms: number }>
}

export async function runGrep(keywords: readonly string[], gold: readonly LineRange[], tools: GrepTools, caps: Caps = CAPS): Promise<PolicyRun> {
  const ep = new Episode(gold, caps)
  const flags = keywords.map((k) => `-e ${JSON.stringify(k)}`).join(' ')

  // 1. rg -c -i <patterns> | sort -t: -k2 -rn | head -50: files by matching lines.
  const counted = await tools.count(keywords)
  const listed = [...counted.files].sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const shown = listed.slice(0, GREP.listLines)
  const list = ep.clip(shown.map((f) => `${f.path}:${f.count}`).join('\n'))
  ep.record('rg --count', flags, list.visible, list.truncated, counted.ms, true, [])
  const ranking = shown.map((f) => f.path)
  if (ranking.length === 0 || ep.done) return { ranking, episode: ep }

  // 2. rg -n -i -m 5 <patterns> -- <top files>: where in each file, shown in ranking order.
  const top = ranking.slice(0, Math.min(GREP.previewFiles, caps.maxFiles))
  const found = await tools.matches(keywords, top, GREP.matchesPerFile)
  const preview = top.flatMap((path) => (found.byPath.get(path) ?? []).slice(0, GREP.matchesPerFile).map((m) => ({ path, ...m })))
  const previewText = preview
    .map((m) => `${m.path}:${m.line}:${m.text.length > GREP.lineChars ? `${m.text.slice(0, GREP.lineChars)} [...]` : m.text}`)
    .join('\n')
  const cut = ep.clip(previewText)
  ep.record('rg -n', `-m ${GREP.matchesPerFile} ${flags} -- ${top.length} files`, cut.visible, cut.truncated, found.ms, true, preview.map((m) => ({ path: m.path, start: m.line, end: m.line })))

  // 3. Ranged reads around those matches, best file first, skipping matches an earlier read showed.
  for (const path of top) {
    const windows: LineRange[] = []
    for (const m of preview) {
      if (ep.done || windows.length >= GREP.readsPerFile) break
      if (m.path !== path || windows.some((w) => m.line >= w.start && m.line <= w.end)) continue
      const r = await tools.read(path, Math.max(1, m.line - GREP.readBefore), m.line + GREP.readAfter)
      const window = { path, start: r.start, end: r.start + r.lines.length - 1 }
      const rc = ep.clip(r.lines.map((l, i) => `${r.start + i}\t${l}`).join('\n'))
      ep.record('read', `${path}:${window.start}-${window.end}`, rc.visible, rc.truncated, r.ms, true, r.lines.length > 0 ? [window] : [])
      windows.push(window)
    }
    if (ep.done) break
  }
  return { ranking, episode: ep }
}
