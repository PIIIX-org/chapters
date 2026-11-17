/**
 * Swift extraction in a child process (#988). The Swift grammar's lexer is one
 * 340 KB Wasm function, and V8 tiering it up took 1.3 to 1.9 GB of resident
 * memory in whichever process parsed with it (macOS arm64, Node 24), against
 * about 115 MB with tier-up off. The flags that switch it off are V8 start-up
 * flags: set later, in a process that also runs other Wasm and the server, they
 * are process-global and unsafe, and NODE_OPTIONS does not accept them. So the
 * grammar lives in a long-lived child started lazily with them fixed on its
 * command line (`CHILD_FLAGS`); the server process never loads it.
 *
 * What an answer can be, and what each means to the caller:
 * - a result: the symbols and imports, possibly `truncated` to the limits below;
 * - a result with `skipped`: the content itself cannot be read within the limits
 *   (the child's own deadline, an over-size or malformed answer). Final for that
 *   content: the file is stored with no symbols and the reason as its note;
 * - a rejection with `IsolatedUnavailable`: the parser process could not answer
 *   (it died, was unreachable, would not start, is stuck, is backing off, or the
 *   queue is full). Nothing is known about the content, so nothing is stored: the
 *   queue's job fails and is retried; an overlay lists the file as unparsed.
 *
 * The child owns the deadline (`isolatedParseTimeoutMs`), on its own monotonic
 * clock, from when its grammar is loaded: a stalled server event loop cannot
 * skip a file the child answered. The server only runs a watchdog, past the
 * deadline plus a grace, for a child that stopped answering altogether.
 *
 * Requests go one at a time. The index lane (the extraction queue, itself one
 * file at a time) is served before the overlay lane (`find_symbols` overlays,
 * a reader's), which is bounded: in length, per caller, and in how long a
 * request waits. A child that keeps failing is restarted with a growing delay.
 * It exits when the server does (the channel closes, and the server kills it on
 * exit), and retires itself, after replying, past an RSS limit or a number of
 * parses (extraction-worker.ts): `--max-old-space-size` caps only its JS heap.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ExtractionResult } from './extraction.js'

/** Default ELARA_ISOLATED_PARSE_TIMEOUT_MS: a 1 MB Swift file of 17,000 symbols takes about 0.7 s once loaded. */
export const DEFAULT_ISOLATED_PARSE_TIMEOUT_MS = 10_000
/** The child's JS heap cap (`--max-old-space-size`); its Wasm memory and compiled code are outside it. */
export const ISOLATED_CHILD_HEAP_MB = 512
/** Default ELARA_ISOLATED_CHILD_RSS_MB: the child retires after a reply that leaves it above this (a 1 MB file peaks near 220). */
export const DEFAULT_CHILD_RSS_MB = 400
/** Default ELARA_ISOLATED_CHILD_MAX_PARSES: the child retires after this many files, so slow growth is reset. */
export const DEFAULT_CHILD_MAX_PARSES = 2_000

/** Requests waiting in each lane. The index lane is fed by one file at a time; the bound is a backstop. */
export const MAX_INDEX_QUEUE = 32
export const MAX_OVERLAY_QUEUE = 4
/** Overlay requests one caller (an MCP connection) may have queued or running. */
export const MAX_OVERLAY_PER_CALLER = 2

/** What the child may send back, and the server accepts: a hostile file can make a small source describe a huge answer. */
export const MAX_REPLY_BYTES = 8 * 1024 * 1024
export const MAX_RESULT_ITEMS = 30_000
export const MAX_NAME_CHARS = 200
export const MAX_IMPORT_CHARS = 300

const FAILURES_BEFORE_BACKOFF = 3
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

/**
 * A file over this many characters is parsed by a child that has parsed nothing before, and that exits after it.
 * tree-sitter's Wasm heap degrades with use: the same 64 KB file took 37 ms in a new process and 362 ms after a
 * hundred small files, 100 KB 94 ms and 850 ms, 400 KB 250 ms and 13 s, and a second 1 MB file did not finish in
 * 60 s (a new process parses it in 0.8 s). Starting one costs about 0.3 s, a fraction of such a file's own time.
 */
export const FRESH_CHILD_CHARS = 16 * 1024

/** The child's fixed V8 flags: no TurboFan tier-up of the Wasm grammar (see above). */
const CHILD_FLAGS = ['--no-wasm-tier-up', '--no-wasm-dynamic-tiering', `--max-old-space-size=${ISOLATED_CHILD_HEAP_MB}`]
const WORKER_PATH = fileURLToPath(new URL('./extraction-worker.ts', import.meta.url))
/** The child parses nothing but code text: it gets no database URL, token or other secret of the server's environment. */
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'NODE_ENV', 'ELARA_ISOLATED_CHILD_RSS_MB', 'ELARA_ISOLATED_CHILD_MAX_PARSES']

export type IsolatedLane = 'index' | 'overlay'

/** The parser process could not answer: nothing is known about the content, so nothing may be stored for it. */
export class IsolatedUnavailable extends Error {
  constructor(
    /** `busy`: the lane is full; `failed`: the process failed, is stuck or is backing off. */
    readonly kind: 'busy' | 'failed',
    readonly reason: string,
  ) {
    super(reason)
    this.name = 'IsolatedUnavailable'
  }
}

/** The longest deadline accepted: the server's timers run at 2 and 1.5 times it, and Node's stop at 2^31 - 1 ms (about 24.8 days). */
export const MAX_ISOLATED_PARSE_TIMEOUT_MS = 3_600_000

/** `ELARA_ISOLATED_PARSE_TIMEOUT_MS` -> a positive whole number of milliseconds, at most `MAX_ISOLATED_PARSE_TIMEOUT_MS`; anything else is the default. */
export function isolatedParseTimeoutMs(raw: string | undefined = process.env.ELARA_ISOLATED_PARSE_TIMEOUT_MS): number {
  if (raw === undefined || raw === '') return DEFAULT_ISOLATED_PARSE_TIMEOUT_MS
  const ms = Number(raw)
  if (Number.isSafeInteger(ms) && ms > 0) return Math.min(ms, MAX_ISOLATED_PARSE_TIMEOUT_MS)
  if (!warnedTimeout) {
    warnedTimeout = true
    console.warn(`ELARA_ISOLATED_PARSE_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive whole number of milliseconds: using ${DEFAULT_ISOLATED_PARSE_TIMEOUT_MS}`)
  }
  return DEFAULT_ISOLATED_PARSE_TIMEOUT_MS
}
let warnedTimeout = false

/** How long the server waits for an answer before it calls the child stuck: well past the child's own deadline. */
export function watchdogMs(timeoutMs: number): number {
  return Math.ceil(timeoutMs * 1.5) + 2_000
}

export interface IsolatedRequest {
  id: number
  language: string
  content: string
  path: string
  edges?: boolean
  /** Milliseconds the child may spend parsing and querying, counted from when its grammar is loaded. */
  budgetMs: number
  /** The child retires after answering this request: it was started for it alone (a large file, see `FRESH_CHILD_CHARS`). */
  retire?: boolean
}
/** `payload` is the result as JSON text, already cut to the limits: the server checks its size before it reads it. */
export type IsolatedReply = { id: number; payload: string; retire?: boolean } | { id: number; error: string }

/** What the child sent is within the limits and has the shape of a result, or why not. */
export function readReply(payload: unknown): { result: ExtractionResult } | { rejected: string } {
  if (typeof payload !== 'string') return { rejected: 'the answer is not text' }
  if (payload.length > MAX_REPLY_BYTES) return { rejected: `the answer is over ${MAX_REPLY_BYTES} bytes` }
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return { rejected: 'the answer is not JSON' }
  }
  const result = value as Partial<ExtractionResult> | null
  if (!result || typeof result !== 'object' || !Array.isArray(result.symbols) || !Array.isArray(result.imports) || !Array.isArray(result.sites)) {
    return { rejected: 'the answer is not a result' }
  }
  if (result.symbols.length > MAX_RESULT_ITEMS || result.imports.length > MAX_RESULT_ITEMS || result.sites.length > MAX_RESULT_ITEMS) {
    return { rejected: `the answer has more than ${MAX_RESULT_ITEMS} symbols, imports or sites` }
  }
  const text = (v: unknown, max: number): boolean => typeof v === 'string' && v.length <= max
  const line = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 1
  for (const s of result.symbols as unknown as Array<Record<string, unknown>>) {
    const ok =
      s !== null && typeof s === 'object' && text(s.name, MAX_NAME_CHARS) && text(s.kind, 32) && line(s.startLine) && line(s.endLine) && typeof s.exported === 'boolean' && (s.parent === undefined || text(s.parent, MAX_NAME_CHARS))
    if (!ok) return { rejected: 'a symbol in the answer is malformed' }
  }
  for (const i of result.imports as unknown as Array<Record<string, unknown>>) {
    if (i === null || typeof i !== 'object' || !text(i.target, MAX_IMPORT_CHARS) || !line(i.line)) return { rejected: 'an import in the answer is malformed' }
  }
  if (result.sites.some((site) => site === null || typeof site !== 'object')) return { rejected: 'a site in the answer is malformed' }
  if (result.truncated !== undefined && !text(result.truncated, 500)) return { rejected: 'the answer carries a malformed note' }
  if (result.skipped !== undefined && !text(result.skipped, 500)) return { rejected: 'the answer carries a malformed note' }
  return { result: result as ExtractionResult }
}

/**
 * The result as the child sends it: symbols and imports whose names are over the limits left out, at most
 * `MAX_RESULT_ITEMS` of each, and few enough that the JSON is at most `MAX_REPLY_BYTES`. A source of 200 KB can
 * name a class with 8,000 characters and give it 5,000 methods: the answer would be 40 MB. `truncated` says what
 * was cut; the rest is exactly what an uncut parse gives.
 */
export function encodeResult(result: ExtractionResult): string {
  const symbols = result.symbols.filter((s) => s.name.length <= MAX_NAME_CHARS && (s.parent === undefined || s.parent.length <= MAX_NAME_CHARS))
  const imports = result.imports.filter((i) => i.target.length <= MAX_IMPORT_CHARS)
  const sites = result.sites
  let keepSymbols = Math.min(symbols.length, MAX_RESULT_ITEMS)
  let keepImports = Math.min(imports.length, MAX_RESULT_ITEMS)
  const build = (): string => {
    const lost = result.symbols.length - keepSymbols + (result.imports.length - keepImports)
    return JSON.stringify({
      imports: imports.slice(0, keepImports),
      symbols: symbols.slice(0, keepSymbols),
      sites: sites.length > MAX_RESULT_ITEMS ? [] : sites,
      ...(lost > 0 ? { truncated: `${lost} symbols or imports left out: names over ${MAX_NAME_CHARS} characters, or over ${MAX_RESULT_ITEMS} items or ${MAX_REPLY_BYTES} bytes of answer` } : {}),
      ...(result.skipped ? { skipped: result.skipped } : {}),
    })
  }
  let payload = build()
  while (payload.length > MAX_REPLY_BYTES && (keepSymbols > 0 || keepImports > 0)) {
    keepSymbols = Math.floor(keepSymbols / 2)
    keepImports = Math.floor(keepImports / 2)
    payload = build()
  }
  return payload
}

/** Calls the process has had to give up on, requests sent back as skipped or unavailable (tests and logs read them). */
export const isolatedStats = { started: 0, failures: 0, skipped: 0, busy: 0 }
/** Requests each child has answered: a child that has answered any is not fresh. */
const served = new WeakMap<ChildProcess, number>()

let child: ChildProcess | null = null
let nextId = 1
let running = false
let consecutiveFailures = 0
let blockedUntil = 0

interface Job {
  request: Omit<IsolatedRequest, 'id' | 'budgetMs'>
  lane: IsolatedLane
  caller: string | undefined
  resolve: (result: ExtractionResult) => void
  reject: (error: Error) => void
  /** Overlay jobs only: gives up a request that waited too long for its turn. */
  waiting?: NodeJS.Timeout
}
const lanes: Record<IsolatedLane, Job[]> = { index: [], overlay: [] }
/** Overlay requests queued or running, by caller. */
const overlayInFlight = new Map<string, number>()

/** The child's pid, or null when none is running (tests). */
export function isolatedChildPid(): number | null {
  return child?.pid ?? null
}

/** Kills the child and forgets its failures, so a test starts from a clean slate. */
export function resetIsolatedChild(): void {
  child?.kill('SIGKILL')
  child = null
  consecutiveFailures = 0
  blockedUntil = 0
}

function noteFailure(): void {
  isolatedStats.failures++
  consecutiveFailures++
  if (consecutiveFailures >= FAILURES_BEFORE_BACKOFF) {
    blockedUntil = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (consecutiveFailures - FAILURES_BEFORE_BACKOFF))
  }
}

function startChild(): ChildProcess {
  if (child?.connected) return child
  const wait = blockedUntil - Date.now()
  if (wait > 0) throw new IsolatedUnavailable('failed', `the Swift parser process failed ${consecutiveFailures} times in a row; it is started again in ${wait} ms`)
  const env: NodeJS.ProcessEnv = {}
  for (const key of CHILD_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
  let started: ChildProcess
  try {
    started = fork(WORKER_PATH, [], {
      // The server runs its TypeScript through tsx (`node --import tsx`), so the child does too, from the same copy.
      execArgv: ['--import', import.meta.resolve('tsx'), ...CHILD_FLAGS],
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
  } catch (err) {
    noteFailure()
    throw new IsolatedUnavailable('failed', `the Swift parser process could not be started (${err instanceof Error ? err.message : String(err)})`)
  }
  isolatedStats.started++
  // Neither the child nor its channel keeps the server alive; a request holds the channel while it waits.
  started.unref()
  started.channel?.unref()
  started.on('error', () => {})
  started.once('exit', () => {
    if (child === started) child = null
  })
  child = started
  if (isolatedStats.started === 1) process.once('exit', () => child?.kill('SIGKILL'))
  return started
}

/** One request and its answer. Rejects with `IsolatedUnavailable` when the child exits, cannot be reached, or stays silent. */
function exchange(worker: ChildProcess, message: IsolatedRequest): Promise<IsolatedReply> {
  const watchdog = watchdogMs(message.budgetMs)
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('exit', onExit)
      worker.off('error', onError)
      worker.channel?.unref()
      settle()
    }
    const fail = (reason: string, kill: boolean): void =>
      finish(() => {
        noteFailure()
        if (kill) {
          if (child === worker) child = null
          worker.kill('SIGKILL')
        }
        reject(new IsolatedUnavailable('failed', reason))
      })
    const onMessage = (reply: IsolatedReply): void => {
      if (reply.id === message.id) finish(() => resolve(reply))
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => fail(`the Swift parser process exited (${signal ?? `code ${code}`}) before it answered`, false)
    const onError = (err: Error): void => fail(`the Swift parser process could not be started or reached (${err.message})`, true)
    // The timer may fire late behind a stalled event loop, with the answer already waiting in the channel: look once
    // more after this turn's I/O (the check phase follows the poll phase) before calling the child stuck.
    const timer = setTimeout(() => setImmediate(() => fail(`the Swift parser process gave no answer within ${watchdog} ms`, true)), watchdog)
    worker.on('message', onMessage)
    worker.once('exit', onExit)
    worker.on('error', onError)
    worker.channel?.ref()
    worker.send(message, (err) => {
      if (err) fail(`the Swift parser process could not be reached (${err.message})`, true)
    })
  })
}

function skippedResult(language: string, why: string): ExtractionResult {
  isolatedStats.skipped++
  return { imports: [], symbols: [], sites: [], skipped: `${language} symbols not extracted: ${why}; the file stays searchable by its text and path` }
}

async function run(job: Job): Promise<ExtractionResult> {
  const { language, path } = job.request
  const timeoutMs = isolatedParseTimeoutMs()
  const fresh = job.request.content.length > FRESH_CHILD_CHARS
  if (fresh && child && (served.get(child) ?? 0) > 0) {
    const used = child
    child = null
    used.kill('SIGKILL')
  }
  const worker = startChild()
  const reply = await exchange(worker, { ...job.request, id: nextId++, budgetMs: timeoutMs, ...(fresh ? { retire: true } : {}) })
  served.set(worker, (served.get(worker) ?? 0) + 1)
  consecutiveFailures = 0
  if ('error' in reply) throw new Error(reply.error)
  if (reply.retire && child === worker) child = null
  const read = readReply(reply.payload)
  if ('rejected' in read) {
    console.warn(`[extraction] ${path}: ${read.rejected}`)
    return skippedResult(language, read.rejected)
  }
  if (read.result.skipped) {
    console.warn(`[extraction] ${path}: ${read.result.skipped}`)
    return skippedResult(language, `the parse took longer than ${timeoutMs} ms (ELARA_ISOLATED_PARSE_TIMEOUT_MS)`)
  }
  if (read.result.truncated) console.warn(`[extraction] ${path}: ${read.result.truncated}`)
  return read.result
}

function release(job: Job): void {
  clearTimeout(job.waiting)
  if (job.lane === 'overlay' && job.caller !== undefined) {
    const left = (overlayInFlight.get(job.caller) ?? 1) - 1
    if (left > 0) overlayInFlight.set(job.caller, left)
    else overlayInFlight.delete(job.caller)
  }
}

/** The next request: the index lane first, so readers cannot starve indexing. */
function pump(): void {
  if (running) return
  const job = lanes.index.shift() ?? lanes.overlay.shift()
  if (!job) return
  running = true
  clearTimeout(job.waiting)
  run(job)
    .then(job.resolve, job.reject)
    .finally(() => {
      release(job)
      running = false
      pump()
    })
}

function busy(why: string): IsolatedUnavailable {
  isolatedStats.busy++
  return new IsolatedUnavailable('busy', why)
}

/**
 * `extractStructure` for a grammar parsed in the child (extraction.ts). Resolves with a result, which has `skipped` set
 * for content that cannot be read within the limits; rejects with `IsolatedUnavailable` when the process could not
 * answer, or an `overlay` request found the lane full, or its caller already has `MAX_OVERLAY_PER_CALLER` in flight.
 */
export function extractInChild(
  language: string,
  content: string,
  path: string,
  options: { edges?: boolean; lane?: IsolatedLane; caller?: string },
): Promise<ExtractionResult> {
  const lane = options.lane ?? 'index'
  const caller = options.caller
  if (lane === 'overlay') {
    if (lanes.overlay.length >= MAX_OVERLAY_QUEUE) return Promise.reject(busy(`${MAX_OVERLAY_QUEUE} overlay requests are already waiting for the Swift parser`))
    if (caller !== undefined && (overlayInFlight.get(caller) ?? 0) >= MAX_OVERLAY_PER_CALLER) return Promise.reject(busy(`this connection already has ${MAX_OVERLAY_PER_CALLER} Swift overlay requests in flight`))
  } else if (lanes.index.length >= MAX_INDEX_QUEUE) {
    return Promise.reject(busy(`${MAX_INDEX_QUEUE} files are already waiting for the Swift parser`))
  }
  return new Promise((resolve, reject) => {
    const job: Job = { request: { language, content, path, edges: options.edges }, lane, caller, resolve, reject }
    if (lane === 'overlay') {
      if (caller !== undefined) overlayInFlight.set(caller, (overlayInFlight.get(caller) ?? 0) + 1)
      // Long enough for the parse ahead of it to hit its deadline, and one more turn; past that the reader is told to retry.
      const waited = isolatedParseTimeoutMs() * 2
      job.waiting = setTimeout(() => {
        lanes.overlay.splice(lanes.overlay.indexOf(job), 1)
        release(job)
        reject(busy(`the request waited ${waited} ms for the Swift parser`))
      }, waited)
    }
    lanes[lane].push(job)
    pump()
  })
}
