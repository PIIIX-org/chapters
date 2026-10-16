// The two scripted "agents" of the premise benchmark. No language model:
// each policy is a fixed procedure, so a run is deterministic up to the
// index Elara builds. Both stop as soon as every gold range has been in
// their context (an oracle stop, the same for both), or when a cap is hit.
//
//   elara  search(question) -> read_file of each hit, best first
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
  /** MCP `read_file` {repositoryId, path}. */
  readFile(path: string): Promise<ToolResponse>
}

interface SearchHit {
  path?: unknown
  resourceType?: unknown
  startLine?: unknown
  endLine?: unknown
  snippet?: unknown
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

export async function runElara(question: string, gold: readonly LineRange[], tools: ElaraTools, caps: Caps = CAPS): Promise<PolicyRun> {
  const ep = new Episode(gold, caps)
  const res = await tools.search(question)
  const { visible, truncated } = ep.clip(res.text)
  const parsed = res.ok ? parseJson(res.text) : undefined
  const hits: SearchHit[] = Array.isArray(parsed) ? (parsed as SearchHit[]) : []
  const ranges = hits.map(symbolLines).filter((r): r is LineRange => r !== null)
  ep.record('search', question, visible, truncated, res.ms, res.ok, ranges)
  const ranking = dedupe(hits.map((h) => h.path).filter((p): p is string => typeof p === 'string'))

  for (const path of ranking.slice(0, caps.maxFiles)) {
    if (ep.done) break
    const file = await tools.readFile(path)
    const cut = ep.clip(file.text)
    const json = file.ok ? parseJson(file.text) : undefined
    const content = json && typeof json === 'object' ? Reflect.get(json, 'content') : undefined
    let lines = 0
    if (typeof content === 'string') {
      lines = cut.truncated ? visibleContentLines(file.text, content, caps.perCallChars) : content.split('\n').length
    }
    ep.record('read_file', path, cut.visible, cut.truncated, file.ms, file.ok, lines > 0 ? [{ path, start: 1, end: lines }] : [])
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
