// Retrieval and evidence metrics for the premise benchmark (#570, #572).
// Pure functions, no I/O: imported by the runner (bun) and the unit tests
// (node --test). Erasable TypeScript only (node strips the types).
//
// Rankings are lists of document ids (repository file paths). A document is
// credited once, at its first position: later repeats are dropped before any
// metric runs. Relevance judgments map a document to a grade > 0; anything
// not in the map is non-relevant.

/** Document id -> graded relevance (> 0). Every question has at least one. */
export type Judgments = ReadonlyMap<string, number>

/** First occurrence of each document, in rank order. */
export function dedupe(ranking: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const doc of ranking) {
    if (seen.has(doc)) continue
    seen.add(doc)
    out.push(doc)
  }
  return out
}

function assertJudged(judgments: Judgments): void {
  let relevant = 0
  for (const grade of judgments.values()) {
    if (!(grade > 0) || !Number.isFinite(grade)) throw new Error(`relevance grades must be finite and > 0, got ${grade}`)
    relevant++
  }
  if (relevant === 0) throw new Error('a question needs at least one relevant document')
}

/** 1-based rank of the first relevant document, or null when none is ranked. */
export function firstRelevantRank(ranking: readonly string[], judgments: Judgments): number | null {
  assertJudged(judgments)
  const i = dedupe(ranking).findIndex((doc) => judgments.has(doc))
  return i < 0 ? null : i + 1
}

/** 1 when a relevant document is within the first k distinct documents, else 0. */
export function hitAtK(ranking: readonly string[], judgments: Judgments, k: number): number {
  const rank = firstRelevantRank(ranking, judgments)
  return rank !== null && rank <= k ? 1 : 0
}

/** 1 / rank of the first relevant document; 0 when none is ranked. */
export function reciprocalRank(ranking: readonly string[], judgments: Judgments): number {
  const rank = firstRelevantRank(ranking, judgments)
  return rank === null ? 0 : 1 / rank
}

/** Discounted cumulative gain of a list of gains (rank 1 first): sum gain_i / log2(i + 1). */
export function dcg(gains: readonly number[], k: number): number {
  let sum = 0
  for (let i = 0; i < Math.min(k, gains.length); i++) sum += gains[i]! / Math.log2(i + 2)
  return sum
}

/**
 * NDCG@k. DCG of the returned (deduplicated) ranking divided by the ideal
 * DCG: the DCG of every judged relevance sorted best first, cut at k. The
 * ideal comes from the judgments, never from the returned list, and each
 * document counts once, so the value is always in [0, 1].
 */
export function ndcgAtK(ranking: readonly string[], judgments: Judgments, k: number): number {
  assertJudged(judgments)
  const gains = dedupe(ranking).map((doc) => judgments.get(doc) ?? 0)
  const ideal = [...judgments.values()].sort((a, b) => b - a)
  return dcg(gains, k) / dcg(ideal, k)
}

// ---- lines -----------------------------------------------------------------

/** Inclusive 1-based line range of one file. */
export interface LineRange {
  path: string
  start: number
  end: number
}

/** The lines an agent has had in its context, per file. */
export class LineSet {
  private readonly byPath = new Map<string, Set<number>>()

  add(path: string, start: number, end: number): void {
    if (!(start >= 1) || end < start) return
    let lines = this.byPath.get(path)
    if (!lines) {
      lines = new Set()
      this.byPath.set(path, lines)
    }
    for (let line = start; line <= end; line++) lines.add(line)
  }

  has(path: string, line: number): boolean {
    return this.byPath.get(path)?.has(line) ?? false
  }

  /** True when every line of the range has been seen. */
  covers(range: LineRange): boolean {
    for (let line = range.start; line <= range.end; line++) if (!this.has(range.path, line)) return false
    return true
  }

  get size(): number {
    let n = 0
    for (const lines of this.byPath.values()) n += lines.size
    return n
  }

  /** Lines present in both sets. */
  intersectionSize(other: LineSet): number {
    let n = 0
    for (const [path, lines] of this.byPath) for (const line of lines) if (other.has(path, line)) n++
    return n
  }
}

/**
 * Line-level precision and recall of what an agent saw against the gold
 * evidence (overlapping gold ranges count each line once): precision = gold
 * lines seen / lines seen (0 when nothing was seen), recall = gold lines
 * seen / gold lines.
 */
export function linePrecisionRecall(gold: readonly LineRange[], seen: LineSet): { precision: number; recall: number } {
  const goldSet = new LineSet()
  for (const r of gold) goldSet.add(r.path, r.start, r.end)
  if (goldSet.size === 0) throw new Error('gold evidence needs at least one line')
  const hit = goldSet.intersectionSize(seen)
  return { precision: seen.size === 0 ? 0 : hit / seen.size, recall: hit / goldSet.size }
}

// ---- tokens ----------------------------------------------------------------

/** Token estimate of text an agent receives: characters / 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ---- aggregation -----------------------------------------------------------

/** What one policy achieved on one question. */
export interface QuestionOutcome {
  /** Distinct documents in the order the policy's first ranking returned them. */
  ranking: string[]
  judgments: Judgments
  /** Tokens / calls spent when the first gold range was fully seen; null = never. */
  tokensToGold: number | null
  callsToGold: number | null
  /** Tokens / calls spent when every gold range was seen; null = never. */
  tokensToAllGold: number | null
  precision: number
  recall: number
  tokens: number
  calls: number
  ms: number
}

export interface Aggregate {
  questions: number
  hit1: number
  hit5: number
  hit10: number
  mrr: number
  ndcg10: number
  /** Questions where the first gold range was reached. */
  goldReached: number
  /** Mean tokens to the first gold range; a miss counts as `missTokens`. */
  tokensToGold: number
  /** Median of the same per-question values. */
  tokensToGoldMedian: number
  /** Mean tokens to the first gold range over the questions that reached it (misses left out; 0 when none). */
  tokensToGoldReached: number
  /** Mean calls to the first gold range; a miss counts as `missCalls`. */
  callsToGold: number
  linePrecision: number
  lineRecall: number
  /** Mean tokens and calls spent per question (whole episode). */
  tokens: number
  calls: number
  msMedian: number
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Rounds to 4 decimals so committed numbers do not churn on float noise. */
export function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000
}

/**
 * Suite-level means. Misses are not dropped from the token and call means:
 * they count as `missTokens` / `missCalls` (the most an episode may spend),
 * so a policy cannot look cheap by giving up early.
 */
export function aggregate(outcomes: readonly QuestionOutcome[], missTokens: number, missCalls: number): Aggregate {
  const toGold = outcomes.map((o) => o.tokensToGold ?? missTokens)
  return {
    questions: outcomes.length,
    hit1: round4(mean(outcomes.map((o) => hitAtK(o.ranking, o.judgments, 1)))),
    hit5: round4(mean(outcomes.map((o) => hitAtK(o.ranking, o.judgments, 5)))),
    hit10: round4(mean(outcomes.map((o) => hitAtK(o.ranking, o.judgments, 10)))),
    mrr: round4(mean(outcomes.map((o) => reciprocalRank(o.ranking, o.judgments)))),
    ndcg10: round4(mean(outcomes.map((o) => ndcgAtK(o.ranking, o.judgments, 10)))),
    goldReached: outcomes.filter((o) => o.tokensToGold !== null).length,
    tokensToGold: Math.round(mean(toGold)),
    tokensToGoldMedian: Math.round(median(toGold)),
    tokensToGoldReached: Math.round(mean(outcomes.flatMap((o) => (o.tokensToGold === null ? [] : [o.tokensToGold])))),
    callsToGold: round4(mean(outcomes.map((o) => o.callsToGold ?? missCalls))),
    linePrecision: round4(mean(outcomes.map((o) => o.precision))),
    lineRecall: round4(mean(outcomes.map((o) => o.recall))),
    tokens: Math.round(mean(outcomes.map((o) => o.tokens))),
    calls: round4(mean(outcomes.map((o) => o.calls))),
    msMedian: Math.round(median(outcomes.map((o) => o.ms))),
  }
}

/**
 * Tokens to gold on the questions both policies reached, the like-for-like
 * cost comparison (the miss price does not enter it).
 */
export function pairedTokensToGold(a: readonly QuestionOutcome[], b: readonly QuestionOutcome[]): { questions: number; elara: number; grep: number } {
  const both = a.flatMap((o, i) => (o.tokensToGold !== null && b[i]?.tokensToGold != null ? [[o.tokensToGold, b[i]!.tokensToGold!] as const] : []))
  return { questions: both.length, elara: Math.round(mean(both.map(([x]) => x))), grep: Math.round(mean(both.map(([, y]) => y))) }
}
