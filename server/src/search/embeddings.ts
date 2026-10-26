import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { config } from '../config.js'
import { recordJob } from '../monitoring/metrics.js'
import type { EmbedBatchRequest, EmbedBatchResponse } from './embedding-worker.js'

export const EMBEDDING_DIM = 384

/**
 * Texts per ONNX run. The pipeline pads every text in a run to the longest
 * one — 512 tokens for nearly any source file — and activation memory grows
 * with the run: measured ~32 MB per text, so the 948 texts one minified
 * bundle produced (file + 947 symbols) peaked at 30.7 GB RSS in one run.
 * Eight texts peak near 360 MB above the loaded model.
 */
const EMBED_BATCH_SIZE = 8

/**
 * bge-small reads at most 512 tokens and the pipeline truncates, but only
 * after tokenizing the whole string (381k tokens for a 742 KB bundle).
 * 512 tokens of source code fit well inside this many characters.
 */
export const MAX_EMBED_CHARS = 16_000

/** The model the local embedder runs (passed to embedding-worker.ts, which imports nothing from here). */
export const LOCAL_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5'

/**
 * Version of how the embedder cuts a text (#453): the `MAX_EMBED_CHARS` cut.
 * Bump it with any change to that. What a note or a file embeds (its block
 * texts) is versioned by embed-key.ts `CHUNK_VERSION` (#452): bumping this
 * one would embed every block of every file and note again.
 */
const EMBED_TEXT_VERSION = 1

/**
 * What produced a vector (#453): the model (`fake` for the test embedder)
 * and the embed-text version. Part of the `embed_note` and extraction job
 * keys and stored on `notes.embedder_id` and `repository_files.embedder_id`;
 * a block's vector carries embed-key.ts `embedKey(text)`, which covers it.
 * Changing either re-embeds every note and file at the next boot, the old
 * vectors searchable until each new one commits.
 */
export const EMBEDDER_ID = `${config.embeddings === 'local' ? LOCAL_EMBEDDING_MODEL : 'fake'}+text${EMBED_TEXT_VERSION}`

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
}

/**
 * Deterministic bag-of-words embedder for tests/dev: each word hashes to
 * a signed basis dimension; texts sharing vocabulary land near each
 * other. No model download, no network — sandbox-test-protocol safe.
 */
class FakeEmbedder implements Embedder {
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.one(t)))
  }

  private one(text: string): number[] {
    const vec = new Array<number>(EMBEDDING_DIM).fill(0)
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
    for (const word of words) {
      const digest = createHash('sha256').update(word).digest()
      const dim = digest.readUInt16BE(0) % EMBEDDING_DIM
      const sign = digest[2]! % 2 === 0 ? 1 : -1
      vec[dim]! += sign
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
    return vec.map((v) => v / norm)
  }
}

/** The request whose batch was running when the embedding worker died (#496). */
export class EmbeddingWorkerCrashError extends Error {
  override name = 'EmbeddingWorkerCrash'
}

interface EmbedRequest {
  batches: string[][]
  next: number
  vectors: number[][]
  resolve(vectors: number[][]): void
  reject(err: unknown): void
}

/**
 * bge-small-en-v1.5 via Transformers.js ONNX — local CPU, content never
 * leaves the instance. The model runs in one worker thread
 * (embedding-worker.ts, #496): one model in memory, one batch in flight, so
 * memory stays what it was on the main thread while the event loop stays free.
 * Callers' requests take turns batch by batch, so a search query waits for at
 * most one batch of a large file, not the whole file. A worker that dies fails
 * the request it was running (reported as an `embedding` job failure) and the
 * next batch starts a fresh one.
 */
export class LocalEmbedder implements Embedder {
  private readonly workerUrl: URL
  private worker: Worker | null = null
  private readonly requests: EmbedRequest[] = []
  /** Index in `requests` whose batch goes next. */
  private turn = 0
  private inFlight: { id: number; request: EmbedRequest } | null = null
  private lastId = 0

  constructor(workerUrl = new URL('./embedding-worker.ts', import.meta.url)) {
    this.workerUrl = workerUrl
  }

  embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return Promise.resolve([])
    // Cut here, not in the worker: a 742 KB file is not copied to it whole.
    const batches: string[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE)
      batches.push(texts.slice(i, i + EMBED_BATCH_SIZE).map((t) => t.slice(0, MAX_EMBED_CHARS)))
    return new Promise((resolve, reject) => {
      this.requests.push({ batches, next: 0, vectors: [], resolve, reject })
      this.pump()
    })
  }

  private pump(): void {
    if (this.inFlight) return
    if (this.requests.length === 0) {
      // Idle: a loaded model must not keep a script (reindex, tests) alive.
      this.worker?.unref()
      return
    }
    if (this.turn >= this.requests.length) this.turn = 0
    const request = this.requests[this.turn]!
    const id = ++this.lastId
    this.inFlight = { id, request }
    const worker = this.spawn()
    worker.ref()
    worker.postMessage({ id, texts: request.batches[request.next]! } satisfies EmbedBatchRequest)
  }

  private spawn(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.workerUrl, { workerData: { model: LOCAL_EMBEDDING_MODEL } })
    let uncaught: unknown
    worker.on('message', (res: EmbedBatchResponse) => this.onResponse(res))
    worker.on('error', (err) => {
      uncaught = err
    })
    worker.on('exit', (code) => {
      this.worker = null
      const crash = new EmbeddingWorkerCrashError(`embedding worker exited with code ${code}`, { cause: uncaught })
      console.error('[embeddings] worker died, the next batch starts a new one:', crash)
      recordJob('embedding', { error: crash })
      const flight = this.inFlight
      this.inFlight = null
      if (flight) this.settle(flight.request, crash)
      this.pump()
    })
    this.worker = worker
    return worker
  }

  private onResponse(res: EmbedBatchResponse): void {
    const flight = this.inFlight
    if (!flight || flight.id !== res.id) return
    this.inFlight = null
    const { request } = flight
    if ('error' in res) {
      this.settle(request, Object.assign(new Error(res.error.message), { name: res.error.name }))
    } else {
      request.vectors.push(...res.vectors)
      request.next++
      if (request.next === request.batches.length) this.settle(request, null)
      else this.turn = this.requests.indexOf(request) + 1
    }
    this.pump()
  }

  /** Takes a request out of the rotation; the one after it moves into its turn. */
  private settle(request: EmbedRequest, err: unknown): void {
    const index = this.requests.indexOf(request)
    this.requests.splice(index, 1)
    this.turn = index
    if (err) request.reject(err)
    else request.resolve(request.vectors)
  }
}

export const embedder: Embedder =
  config.embeddings === 'local' ? new LocalEmbedder() : new FakeEmbedder()

/**
 * The text a search query is embedded and cached as (#684): Unicode NFC,
 * whitespace runs collapsed to one space, trimmed. The tokenizer splits on
 * whitespace either way, so this only merges spellings that tokenize alike.
 * No case folding: the cache must not decide what the model distinguishes.
 */
export function normalizeQueryText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** Query vectors kept per process: ~3 KB each (384 numbers), so ~4 MB when full. */
export const QUERY_EMBEDDING_CACHE_ENTRIES = 1000

/**
 * Repeated search queries skip the embedder (#684): an in-process LRU of
 * query vectors keyed by sha256(embedder id + account id + normalised text).
 * The embedder id (`EMBEDDER_ID`: model + embed-text version) is read on
 * every call, so a vector never outlives the model that made it. The account
 * is in the key because a hit answers ~4 ms faster than an embed: shared
 * across accounts, that timing would tell one account whether another
 * searched the same text (backend-reference.md §5.11, the rule for every
 * in-process cache). Agents of one account share hits. A vector depends on
 * no content, so the key needs no epoch. Concurrent identical queries of one
 * account share one embed; a failed embed is not kept. Vectors are shared:
 * callers must not mutate them.
 *
 * In process only: an embed of a query costs milliseconds and a lookup in
 * Postgres a round trip, so a shared tier would save little (measured in
 * the #684 PR).
 */
export class QueryEmbeddingCache {
  private readonly entries = new Map<string, Promise<readonly number[]>>()

  constructor(
    private readonly inner: Embedder,
    private readonly embedderId: () => string,
    private readonly capacity: number,
  ) {}

  get size(): number {
    return this.entries.size
  }

  embed(accountId: string, query: string): Promise<readonly number[]> {
    const text = normalizeQueryText(query)
    const key = createHash('sha256').update(`${this.embedderId()}\n${accountId}\n${text}`).digest('hex')
    const hit = this.entries.get(key)
    if (hit) {
      // Most recently used last: Map iteration order is insertion order.
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit
    }
    const vector = this.inner.embed([text]).then(([v]) => {
      if (!v) throw new Error('embedder returned no vector for the query')
      return v
    })
    this.entries.set(key, vector)
    vector.catch(() => {
      if (this.entries.get(key) === vector) this.entries.delete(key)
    })
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break
      this.entries.delete(oldest)
    }
    return vector
  }

  clear(): void {
    this.entries.clear()
  }
}

/** The process's query cache; the test setup clears it per test, so an embedder mock sees every query. */
export const queryEmbeddings = new QueryEmbeddingCache(embedder, () => EMBEDDER_ID, QUERY_EMBEDDING_CACHE_ENTRIES)

/**
 * A search query's vector. With the asking account, from the query cache
 * when that account embedded the same text before; with null (a caller with
 * no account at hand) embedded afresh and not kept, so nothing is shared.
 */
export async function embedQuery(query: string, accountId: string | null): Promise<readonly number[]> {
  if (accountId !== null) return queryEmbeddings.embed(accountId, query)
  const [vector] = await embedder.embed([normalizeQueryText(query)])
  if (!vector) throw new Error('embedder returned no vector for the query')
  return vector
}
