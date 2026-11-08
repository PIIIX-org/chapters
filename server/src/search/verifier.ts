// The verifier stage (#1061): after fusion, a cross-encoder reads the query with each of the top passages and the
// list is reordered by what it says; the answer then commits to one span with a confidence, says two are close, or
// says nothing. Local ONNX, no LLM (#473): the same query and passages give the same scores for one `VERIFIER_ID`.
import { Worker } from 'node:worker_threads'
import { config } from '../config.js'
import type { VerifyRequest, VerifyResponse } from './verifier-worker.js'

/** English only (a multilingual reranker is phase 5): see `isLatinQuery`. */
export const VERIFIER_MODEL = 'jinaai/jina-reranker-v1-tiny-en'
const VERIFIER_DTYPE = 'int8'
/** Tokens of query and passage together the model reads. Bump `VERIFY_TEXT_VERSION` with any change to how a passage is cut (`hitText`). */
const VERIFY_MAX_TOKENS = 256
const VERIFY_TEXT_VERSION = 1

/** What scored a list (#1061, like `EMBEDDER_ID`, #453): the model, its precision and the passage text version. Nothing derived is stored, so a change needs no migration; the benchmark's harness hashes this file. */
export const VERIFIER_ID = `${config.verifier === 'local' ? `${VERIFIER_MODEL}+${VERIFIER_DTYPE}` : config.verifier}+text${VERIFY_TEXT_VERSION}`

/** The passages one search scores: the top of the fused list. */
export const VERIFY_TOP_N = 30
/** `confidence` (the top probability minus the runner-up's) from which the answer commits to one span. */
export const ANSWER_MIN_CONFIDENCE = 0.5
/** A runner-up at least this probable, with no clear winner, makes the answer ambiguous. */
export const AMBIGUOUS_RUNNER_UP = 0.5
/** Requests waiting for the worker: a slower CPU drops the rest instead of piling up. shortcut: a request that timed out leaves the count but its scoring still runs in the worker; a queue with cancel if a slow box shows it. */
const MAX_QUEUED = 4

/** Scores of passages against a query, each in [0, 1]. */
export interface Verifier {
  score(query: string, passages: string[]): Promise<number[]>
}

/** Deterministic stand-in for tests: the share of the query's words (3+ letters) a passage contains. */
export class FakeVerifier implements Verifier {
  score(query: string, passages: string[]): Promise<number[]> {
    const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
    return Promise.resolve(passages.map((p) => (words.length === 0 ? 0 : words.filter((w) => p.toLowerCase().includes(w)).length / words.length)))
  }
}

/** The cross-encoder in one worker thread: the model loads on the first use (or `warm`) and is downloaded and cached like the embedder's. */
export class LocalVerifier implements Verifier {
  private worker: Worker | null = null
  private lastId = 0
  private readonly pending = new Map<number, { resolve(scores: number[]): void; reject(err: Error): void }>()

  constructor(
    private readonly timeoutMs: number,
    private readonly workerUrl = new URL('./verifier-worker.ts', import.meta.url),
  ) {}

  warm(): void {
    this.spawn().postMessage({ warm: true })
  }

  score(query: string, passages: string[]): Promise<number[]> {
    if (this.pending.size >= MAX_QUEUED) return Promise.reject(new Error('verifier busy'))
    const id = ++this.lastId
    const worker = this.spawn()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`verifier timed out after ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (scores) => (clearTimeout(timer), resolve(scores)),
        reject: (err) => (clearTimeout(timer), reject(err)),
      })
      worker.postMessage({ id, query, texts: passages } satisfies VerifyRequest)
    })
  }

  private spawn(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.workerUrl, { workerData: { model: VERIFIER_MODEL, dtype: VERIFIER_DTYPE, maxTokens: VERIFY_MAX_TOKENS } })
    worker.unref()
    worker.on('message', (res: VerifyResponse) => {
      const request = this.pending.get(res.id)
      if (!request) return
      this.pending.delete(res.id)
      if ('error' in res) request.reject(Object.assign(new Error(res.error.message), { name: res.error.name }))
      else request.resolve(res.scores)
    })
    worker.on('error', (err) => console.error('[verifier] worker error:', err))
    worker.on('exit', (code) => {
      this.worker = null
      for (const request of this.pending.values()) request.reject(new Error(`verifier worker exited with code ${code}`))
      this.pending.clear()
    })
    this.worker = worker
    return worker
  }
}

export const verifier: Verifier | null =
  config.verifier === 'local' ? new LocalVerifier(config.verifyTimeoutMs) : config.verifier === 'fake' ? new FakeVerifier() : null

/** Starts loading the model, so the first search does not wait for the download. */
export function warmVerifier(): void {
  if (verifier instanceof LocalVerifier) verifier.warm()
}

/** A query the English model can read: every letter in it is Latin (digits and punctuation do not count). */
export function isLatinQuery(query: string): boolean {
  return [...query.matchAll(/\p{L}/gu)].every((m) => /\p{Script=Latin}/u.test(m[0]))
}

export interface Verdict {
  /** Indexes into the passages, best first; equal scores keep their fused order. */
  order: number[]
  /** The top probability minus the runner-up's, 0 to 1. */
  confidence: number
  /** The top passage is the answer. */
  answer: boolean
  /** Two passages are close and likely: the agent should read both. */
  ambiguous: boolean
}

/** Orders passages by score and decides: one span clearly ahead, two close, or nothing above the floor. */
export function decide(scores: number[]): Verdict {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]! || a - b)
  const p1 = scores[order[0]!] ?? 0
  const p2 = scores[order[1]!] ?? 0
  const confidence = Math.round(Math.max(0, p1 - p2) * 100) / 100
  const answer = confidence >= ANSWER_MIN_CONFIDENCE
  return { order, confidence, answer, ambiguous: !answer && p2 >= AMBIGUOUS_RUNNER_UP }
}

/** What a passage reads: its name and place, then the located block (or, for a hit not located, its snippet; the `<b>` marks of a headline are dropped). */
export function hitText(h: { path: string; snippet: string; symbolName?: string; symbolKind?: string; symbolParent?: string }, passage?: string): string {
  const name = h.symbolName === undefined ? '' : `${h.symbolKind ?? 'symbol'} ${h.symbolParent ? `${h.symbolParent}.` : ''}${h.symbolName}\n`
  return `${name}${h.path}\n${passage ?? h.snippet.replace(/<\/?b>/g, '')}`
}

/** The fields the verifier adds to a search answer. */
export interface VerifierFields {
  /** `applied`: the list is ordered by the verifier; `skipped_language`: the query is not Latin and the fused order stands (the English model cannot read it). */
  verifier?: 'applied' | 'skipped_language'
  confidence?: number
  ambiguous?: true
  /** The location of the one span the answer commits to: `path#La-Lb` for a symbol, else the path. */
  answer?: string
  /** The verifier failed or timed out: the fused order stands. */
  degraded?: { reason: 'verifier_failed' }
}

interface Hit {
  path: string
  snippet: string
  symbolName?: string
  symbolKind?: string
  symbolParent?: string
  startLine?: number
  endLine?: number
}

/**
 * Reorders the top `VERIFY_TOP_N` of a fused list by the verifier and decides. No verifier or fewer than two hits leave the list as it is; a failure says so (`degraded`), a
 * non-Latin query says `skipped_language`.
 */
export async function verifyHits<H extends Hit>(query: string, hits: H[], impl: Verifier | null, passages: ReadonlyMap<H, string> = new Map()): Promise<{ hits: H[]; fields: VerifierFields }> {
  if (impl === null) return { hits, fields: {} }
  if (!isLatinQuery(query)) return { hits, fields: { verifier: 'skipped_language' } }
  if (hits.length < 2) return { hits, fields: {} }
  const top = hits.slice(0, VERIFY_TOP_N)
  try {
    const scores = await impl.score(query, top.map((h) => hitText(h, passages.get(h))))
    if (scores.length !== top.length) throw new Error(`verifier returned ${scores.length} scores for ${top.length} passages`)
    const verdict = decide(scores)
    const best = top[verdict.order[0]!]!
    return {
      hits: [...verdict.order.map((i) => top[i]!), ...hits.slice(VERIFY_TOP_N)],
      fields: {
        verifier: 'applied',
        confidence: verdict.confidence,
        ...(verdict.ambiguous ? { ambiguous: true as const } : {}),
        ...(verdict.answer ? { answer: best.startLine !== undefined && best.endLine !== undefined ? `${best.path}#L${best.startLine}-L${best.endLine}` : best.path } : {}),
      },
    }
  } catch (err) {
    console.warn('[search] the verifier failed; answering in the fused order:', err)
    return { hits, fields: { degraded: { reason: 'verifier_failed' } } }
  }
}
