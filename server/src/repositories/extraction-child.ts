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
 * One request at a time, JSON over the IPC channel. The parent enforces a
 * deadline per request (`isolatedParseTimeoutMs`): past it the child is killed,
 * the next request starts a new one, and the file gets no symbols and a
 * `skipped` reason, never an exception (a parse is synchronous in the child, so
 * a pathological file would otherwise stall every request of the server, #1146).
 * A child that exits (an OOM kill, a crash) is handled the same way. It exits
 * when the parent does (the channel closes, and the parent kills it on exit).
 */
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ExtractionResult } from './extraction.js'

/** Default ELARA_ISOLATED_PARSE_TIMEOUT_MS: a 1 MB Swift file of 17,000 symbols takes about 0.7 s; a cold start 0.3 s. */
export const DEFAULT_ISOLATED_PARSE_TIMEOUT_MS = 10_000
/** The child's JS heap cap (`--max-old-space-size`); its Wasm memory and compiled code are outside it. */
export const ISOLATED_CHILD_HEAP_MB = 512

/** The child's fixed V8 flags: no TurboFan tier-up of the Wasm grammar (see above). */
const CHILD_FLAGS = ['--no-wasm-tier-up', '--no-wasm-dynamic-tiering', `--max-old-space-size=${ISOLATED_CHILD_HEAP_MB}`]
const WORKER_PATH = fileURLToPath(new URL('./extraction-worker.ts', import.meta.url))
/** The child parses nothing but code text: it gets no database URL, token or other secret of the server's environment. */
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'NODE_ENV']

/** `ELARA_ISOLATED_PARSE_TIMEOUT_MS` -> a positive whole number of milliseconds; anything else is the default. */
export function isolatedParseTimeoutMs(raw: string | undefined = process.env.ELARA_ISOLATED_PARSE_TIMEOUT_MS): number {
  if (raw === undefined || raw === '') return DEFAULT_ISOLATED_PARSE_TIMEOUT_MS
  const ms = Number(raw)
  if (Number.isSafeInteger(ms) && ms > 0) return ms
  if (!warnedTimeout) {
    warnedTimeout = true
    console.warn(`ELARA_ISOLATED_PARSE_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive whole number of milliseconds: using ${DEFAULT_ISOLATED_PARSE_TIMEOUT_MS}`)
  }
  return DEFAULT_ISOLATED_PARSE_TIMEOUT_MS
}
let warnedTimeout = false

export interface IsolatedRequest {
  id: number
  language: string
  content: string
  path: string
  edges?: boolean
  /** Milliseconds the child may parse: its own limit, a little past the parent's (the parent kills it first). */
  budgetMs: number
}
export type IsolatedReply = { id: number; result: ExtractionResult } | { id: number; error: string }

/** Children started and requests given up on since the process started (tests and logs read them). */
export const isolatedStats = { started: 0, timeouts: 0, exits: 0 }

let child: ChildProcess | null = null
let nextId = 1
/** Requests wait their turn: the child parses one at a time, and the deadline of a request counts from its start. */
let turn: Promise<unknown> = Promise.resolve()

/** The child's pid, or null when none is running (tests). */
export function isolatedChildPid(): number | null {
  return child?.pid ?? null
}

function startChild(): ChildProcess {
  if (child?.connected) return child
  const env: NodeJS.ProcessEnv = {}
  for (const key of CHILD_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
  const started = fork(WORKER_PATH, [], {
    // The server runs its TypeScript through tsx (`node --import tsx`), so the child does too, from the same copy.
    execArgv: ['--import', import.meta.resolve('tsx'), ...CHILD_FLAGS],
    env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
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

/** Gives the child up: killed, and the next request starts another. */
function discard(worker: ChildProcess): void {
  if (child === worker) child = null
  worker.kill('SIGKILL')
}

function skippedResult(language: string, why: string): ExtractionResult {
  return { imports: [], symbols: [], sites: [], skipped: `${language} symbols not extracted: ${why}; the file stays searchable by its text and path` }
}

function request(language: string, content: string, path: string, edges: boolean | undefined): Promise<ExtractionResult> {
  // `Promise.withResolvers` is ES2024; the project's target is ES2023.
  let resolve!: (result: ExtractionResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ExtractionResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  const timeoutMs = isolatedParseTimeoutMs()
  const worker = startChild()
  const id = nextId++
  let settled = false
  const settle = (finish: () => void): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    worker.off('message', onMessage)
    worker.off('exit', onExit)
    worker.channel?.unref()
    finish()
  }
  const giveUp = (why: string, kill: boolean): void =>
    settle(() => {
      if (kill) discard(worker)
      console.warn(`[extraction] ${path}: ${why}`)
      resolve(skippedResult(language, why))
    })
  const onMessage = (reply: IsolatedReply): void => {
    if (reply.id !== id) return
    if ('error' in reply) settle(() => reject(new Error(reply.error)))
    else if (reply.result.skipped) giveUp(reply.result.skipped, false)
    else settle(() => resolve(reply.result))
  }
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    isolatedStats.exits++
    giveUp(`the ${language} parser process exited (${signal ?? `code ${code}`})`, false)
  }
  const timer = setTimeout(() => {
    isolatedStats.timeouts++
    giveUp(`no result within ${timeoutMs} ms (ELARA_ISOLATED_PARSE_TIMEOUT_MS)`, true)
  }, timeoutMs)
  worker.on('message', onMessage)
  worker.once('exit', onExit)
  worker.channel?.ref()
  const message: IsolatedRequest = { id, language, content, path, edges, budgetMs: timeoutMs + 1000 }
  worker.send(message, (err) => {
    if (err) giveUp(`the ${language} parser process could not be reached (${err.message})`, true)
  })
  return promise
}

/** `extractStructure` for a grammar parsed in the child (extraction.ts); resolves with `skipped` set, never rejects for a timeout or a dead child. */
export function extractInChild(language: string, content: string, path: string, options: { edges?: boolean }): Promise<ExtractionResult> {
  const run = turn.then(() => request(language, content, path, options.edges))
  turn = run.catch(() => undefined)
  return run
}
