// In-process error reporting and request/job metrics (#705), read by the
// uptime monitor through GET /api/admin/monitoring (routes.ts).
//
// Bounded: per-route counters live in WINDOW_MINUTES one-minute slots, routes
// are capped at MAX_ROUTES keys, the error ring keeps MAX_ERRORS records.
// Totals since boot are plain counters, so a monitor that checks late misses
// nothing; a restart resets them (the monitor sees a new bootId).
//
// What a report may carry is fixed here, not by the caller: route templates
// (never the raw URL, so no path segment or query string), status, duration,
// request id, actor kind, job kind, a subject UUID, and the error's class name
// and code, each format-checked. Never the error message: messages quote note
// text, note paths (= titles) and URLs, and the credential redaction of PRs
// #592/#643 (`redactGitSecrets`) recognises credentials, not note text.
// Single-process, like the rest of the server (backend-reference.md §9).
//
// The same store also serves GET /api/admin/metrics (routes.ts) in the
// Prometheus text format: the totals above as counters, and the instruments
// after `metricsSnapshot`: process memory and event-loop lag (sampled by
// sampler.ts every SAMPLE_INTERVAL_MS), the pending jobs per kind with the
// age of the oldest, and fixed-bucket duration histograms of each search leg
// and of each extraction stage per file. An observation is three integer
// updates on preallocated arrays: nothing is allocated on the hot path.

import { monitorEventLoopDelay } from 'node:perf_hooks'
import { bootInfo } from '../lifecycle.js'

export const WINDOW_MINUTES = 15
export const MAX_ROUTES = 300
export const MAX_ERRORS = 50
/** Upper bounds (ms) of the latency buckets; percentiles report the bucket's bound, capped at the max seen. */
export const LATENCY_BUCKETS_MS = [
  1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000,
  4000, 5000, 7500, 10_000, 15_000, 20_000, 30_000, 60_000, Infinity,
]
export const JOB_KINDS = ['embedding', 'extraction', 'sync', 'collab-store', 'backup', 'projection', 'compaction', 'links', 'semantic-edges'] as const
export type JobKind = (typeof JOB_KINDS)[number]
export type ActorKind = 'user' | 'token' | 'anonymous'

/** Route key for requests no route matched (404s, the SPA fallback). */
export const OTHER_ROUTE = '(other)'
const METHODS: Record<string, true> = { GET: true, POST: true, PUT: true, PATCH: true, DELETE: true, HEAD: true, OPTIONS: true }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENT = /^[A-Za-z][\w.-]{0,63}$/
const REQ_ID = /^[\w.-]{1,64}$/
const TEMPLATE = /^\/[\w/:*.-]{0,200}$/

export interface ErrorInfo {
  name: string | null
  code: string | null
}

export type ErrorReport =
  | {
      type: 'request'
      reqId: string | null
      route: string
      status: number
      durationMs: number
      actor: ActorKind
      error: ErrorInfo | null
    }
  | {
      type: 'job'
      job: JobKind
      subjectId: string | null
      error: ErrorInfo
    }

/** A report as kept in the ring: `seq` grows by one per report since boot. */
export type ErrorRecord = ErrorReport & { seq: number; at: string }

interface RouteSlot {
  count: number
  serverErrors: number
  maxMs: number
  buckets: number[]
}

interface Slot {
  minute: number
  routes: Map<string, RouteSlot>
}

const slots: Slot[] = []
const errors: ErrorRecord[] = []
let seq = 0
const totals = { requests: 0, serverErrors: 0, jobFailures: 0 }
const jobs = Object.fromEntries(JOB_KINDS.map((k) => [k, { succeeded: 0, failed: 0, repeated: 0 }])) as Record<
  JobKind,
  { succeeded: number; failed: number; repeated: number }
>
/** Conflict copies (ADR-003 §7, #842): documented behaviour, so counted apart from job failures. */
const conflicts = { copies: 0, paths: new Set<string>() }

/** `{name, code}` of a thrown value, each kept only when it looks like an identifier (never the message). */
export function errorInfo(err: unknown): ErrorInfo {
  if (typeof err !== 'object' || err === null) return { name: null, code: null }
  const rawName = 'name' in err ? err.name : err.constructor?.name
  const rawCode = 'code' in err ? err.code : null
  const name = typeof rawName === 'string' && IDENT.test(rawName) ? rawName : null
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : null
  return { name, code: code && /^[\w.-]{1,64}$/.test(code) ? code : null }
}

/** `METHOD /template` for a matched route, `METHOD (other)` otherwise. */
export function routeKey(method: string, template: string | undefined): string {
  const m = Object.hasOwn(METHODS, method) ? method : 'OTHER'
  return `${m} ${template && TEMPLATE.test(template) ? template : OTHER_ROUTE}`
}

function bucketIndex(ms: number): number {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) if (ms <= LATENCY_BUCKETS_MS[i]!) return i
  return LATENCY_BUCKETS_MS.length - 1
}

function currentSlot(now: number): Slot {
  const minute = Math.floor(now / 60_000)
  const last = slots.at(-1)
  if (last && last.minute === minute) return last
  const slot = { minute, routes: new Map<string, RouteSlot>() }
  slots.push(slot)
  while (slots.length > 0 && slots[0]!.minute <= minute - WINDOW_MINUTES) slots.shift()
  return slot
}

/** True when `key` is not in the window yet and the window already holds MAX_ROUTES keys. */
function overRouteCap(key: string): boolean {
  const keys = new Set<string>()
  for (const s of slots) for (const k of s.routes.keys()) keys.add(k)
  return !keys.has(key) && keys.size >= MAX_ROUTES
}

function pushError(report: ErrorReport, now: number): ErrorRecord {
  const full: ErrorRecord = { seq: ++seq, at: new Date(now).toISOString(), ...report }
  errors.push(full)
  if (errors.length > MAX_ERRORS) errors.shift()
  return full
}

/** One structured log line per report: the same fields as the endpoint, nothing else. */
function logReport(record: ErrorRecord): void {
  console.error(JSON.stringify({ event: record.type === 'request' ? 'server_error' : 'job_failure', ...record }))
}

export interface RequestSample {
  method: string
  /** The route template (`req.routeOptions.url`), never the URL. */
  template: string | undefined
  status: number
  durationMs: number
  reqId: string
  actor: ActorKind
  /** The error the handler threw, when it threw. */
  error?: unknown
}

/** Counts one finished request; a 5xx is also an error report. */
export function recordRequest(sample: RequestSample, now = Date.now()): void {
  let route = routeKey(sample.method, sample.template)
  const slot = currentSlot(now)
  if (!slot.routes.has(route) && overRouteCap(route)) route = routeKey(sample.method, undefined)
  let r = slot.routes.get(route)
  if (!r) {
    r = { count: 0, serverErrors: 0, maxMs: 0, buckets: new Array<number>(LATENCY_BUCKETS_MS.length).fill(0) }
    slot.routes.set(route, r)
  }
  const ms = Number.isFinite(sample.durationMs) && sample.durationMs >= 0 ? sample.durationMs : 0
  r.count++
  r.buckets[bucketIndex(ms)]!++
  if (ms > r.maxMs) r.maxMs = ms
  totals.requests++
  if (sample.status < 500) return
  r.serverErrors++
  totals.serverErrors++
  logReport(
    pushError(
      {
        type: 'request',
        reqId: REQ_ID.test(sample.reqId) ? sample.reqId : null,
        route,
        status: sample.status,
        durationMs: Math.round(ms),
        actor: sample.actor,
        error: sample.error === undefined ? null : errorInfo(sample.error),
      },
      now,
    ),
  )
}

/**
 * One background job outcome: `'ok'`, or the thrown value for a failure
 * (counted, kept in the error ring, logged). `subjectId` is the note, file,
 * repository or vault the job was about; anything but a UUID is dropped.
 * `repeat: true` marks a failure of a subject that was already failing (a
 * repository in `error` whose poll fails again): only `repeated` counts it,
 * so a failure that keeps happening is reported once, not on every retry, and
 * cannot push other records out of the ring.
 */
export function recordJob(
  kind: JobKind,
  outcome: 'ok' | { error: unknown; repeat?: boolean },
  subjectId: string | null = null,
  now = Date.now(),
): void {
  if (outcome === 'ok') {
    jobs[kind].succeeded++
    return
  }
  if (outcome.repeat) {
    jobs[kind].repeated++
    return
  }
  jobs[kind].failed++
  totals.jobFailures++
  logReport(
    pushError(
      { type: 'job', job: kind, subjectId: subjectId && UUID.test(subjectId) ? subjectId : null, error: errorInfo(outcome.error) },
      now,
    ),
  )
}

/**
 * One `.conflicts/` copy the projector made of a file it did not write
 * (#842). Intended behaviour, not a failure: no error report, no log line, no
 * `jobs` alert. The endpoint shows the number of copies and of distinct
 * vault/path pairs, never the path itself.
 */
export function recordConflictCopy(vaultId: string, path: string): void {
  conflicts.copies++
  conflicts.paths.add(`${vaultId}/${path}`)
}

function percentile(buckets: number[], count: number, maxMs: number, p: number): number {
  const rank = Math.ceil(count * p)
  let seen = 0
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i]!
    if (seen >= rank) return Math.round(Math.min(LATENCY_BUCKETS_MS[i]!, maxMs))
  }
  return Math.round(maxMs)
}

export interface RouteStats {
  route: string
  count: number
  serverErrors: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

/** What GET /api/admin/monitoring returns. */
export function metricsSnapshot(now = Date.now()) {
  const minute = Math.floor(now / 60_000)
  const merged = new Map<string, RouteSlot>()
  for (const s of slots) {
    if (s.minute <= minute - WINDOW_MINUTES) continue
    for (const [key, r] of s.routes) {
      let m = merged.get(key)
      if (!m) {
        m = { count: 0, serverErrors: 0, maxMs: 0, buckets: new Array<number>(LATENCY_BUCKETS_MS.length).fill(0) }
        merged.set(key, m)
      }
      m.count += r.count
      m.serverErrors += r.serverErrors
      m.maxMs = Math.max(m.maxMs, r.maxMs)
      for (let i = 0; i < r.buckets.length; i++) m.buckets[i]! += r.buckets[i]!
    }
  }
  const routes: RouteStats[] = [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([route, r]) => ({
      route,
      count: r.count,
      serverErrors: r.serverErrors,
      p50Ms: percentile(r.buckets, r.count, r.maxMs, 0.5),
      p95Ms: percentile(r.buckets, r.count, r.maxMs, 0.95),
      p99Ms: percentile(r.buckets, r.count, r.maxMs, 0.99),
      maxMs: Math.round(r.maxMs),
    }))
  const { bootId, startedAt } = bootInfo()
  return {
    bootId,
    startedAt,
    now: new Date(now).toISOString(),
    windowMinutes: WINDOW_MINUTES,
    totals: { ...totals },
    jobs: Object.fromEntries(JOB_KINDS.map((k) => [k, { ...jobs[k] }])) as Record<JobKind, { succeeded: number; failed: number; repeated: number }>,
    conflictCopies: { copies: conflicts.copies, paths: conflicts.paths.size },
    routes,
    errors: errors.map((e) => ({ ...e })),
    lastSeq: seq,
  }
}

/** Test-only: forget everything recorded so far. */
export function resetMetrics(): void {
  slots.length = 0
  errors.length = 0
  seq = 0
  totals.requests = 0
  totals.serverErrors = 0
  totals.jobFailures = 0
  for (const k of JOB_KINDS) jobs[k] = { succeeded: 0, failed: 0, repeated: 0 }
  conflicts.copies = 0
  conflicts.paths.clear()
}

// ---------------------------------------------------------------------------
// Prometheus exposition: GET /api/admin/metrics

/**
 * Upper bounds (ms) of the duration histograms (search legs, extraction
 * stages). Shorter than LATENCY_BUCKETS_MS: a histogram is exported whole,
 * one series per bucket per label.
 */
export const DURATION_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, Infinity]

/**
 * The legs of a search (search.ts): the three keyword legs, the three vector
 * legs, the query embedding they wait for, and the fusion of their rows.
 */
export const SEARCH_LEGS = ['note_keyword', 'code_keyword', 'symbol_keyword', 'note_vector', 'code_vector', 'symbol_vector', 'query_embed', 'fusion'] as const
export type SearchLeg = (typeof SEARCH_LEGS)[number]

/** The stages of one file's extraction (extraction-queue.ts `processFile`). */
export const INDEX_STAGES = ['extract', 'embed', 'write'] as const
export type IndexStage = (typeof INDEX_STAGES)[number]

interface Histogram {
  /** One count per DURATION_BUCKETS_MS bound (not cumulative; export sums them). */
  buckets: Uint32Array
  count: number
  sumMs: number
}

function histogram(): Histogram {
  return { buckets: new Uint32Array(DURATION_BUCKETS_MS.length), count: 0, sumMs: 0 }
}

function observe(h: Histogram, ms: number): void {
  if (!(ms >= 0)) ms = 0
  let i = 0
  while (i < DURATION_BUCKETS_MS.length - 1 && ms > DURATION_BUCKETS_MS[i]!) i++
  h.buckets[i]!++
  h.count++
  h.sumMs += ms
}

const searchLegs = Object.fromEntries(SEARCH_LEGS.map((l) => [l, histogram()])) as Record<SearchLeg, Histogram>
const indexStages = Object.fromEntries(INDEX_STAGES.map((s) => [s, histogram()])) as Record<IndexStage, Histogram>

/** One search leg's duration (ms), measured around its query by search.ts. */
export function observeSearchLeg(leg: SearchLeg, ms: number): void {
  observe(searchLegs[leg], ms)
}

/** One extraction stage's duration (ms) for one file, measured by extraction-queue.ts. */
export function observeIndexStage(stage: IndexStage, ms: number): void {
  observe(indexStages[stage], ms)
}

/** `process.memoryUsage()` at the last sample, bytes; `sampledAt` 0 until the first. */
const processMemory = { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0, sampledAt: 0 }

/** Reads `process.memoryUsage()` into the gauges (sampler.ts, every SAMPLE_INTERVAL_MS). */
export function sampleProcessMemory(now = Date.now()): void {
  const m = process.memoryUsage()
  processMemory.rss = m.rss
  processMemory.heapUsed = m.heapUsed
  processMemory.heapTotal = m.heapTotal
  processMemory.external = m.external
  processMemory.arrayBuffers = m.arrayBuffers
  processMemory.sampledAt = now
}

/** Event-loop lag over the last sample interval, ms; `sampledAt` 0 until the first sample. */
const eventLoop = { p50: 0, p99: 0, max: 0, mean: 0, sampledAt: 0 }
// @types/node of this workspace does not export `IntervalHistogram`; the monitor's own type is the contract.
let loopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null

/**
 * Starts `monitorEventLoopDelay` (10 ms resolution). Each `sampleEventLoop`
 * reads its percentiles and resets it, so the gauges describe the interval
 * since the previous sample, not the whole uptime. Idempotent.
 */
export function startEventLoopMonitor(): void {
  if (loopDelay) return
  loopDelay = monitorEventLoopDelay({ resolution: 10 })
  loopDelay.enable()
}

export function stopEventLoopMonitor(): void {
  loopDelay?.disable()
  loopDelay = null
}

/** Moves the monitor's percentiles (nanoseconds) into the gauges (ms) and resets it; no-op before `startEventLoopMonitor`. */
export function sampleEventLoop(now = Date.now()): void {
  if (!loopDelay) return
  // A histogram with no sample reports NaN percentiles and a max of 0.
  const ms = (ns: number) => (Number.isFinite(ns) ? ns / 1e6 : 0)
  eventLoop.p50 = ms(loopDelay.percentile(50))
  eventLoop.p99 = ms(loopDelay.percentile(99))
  eventLoop.max = ms(loopDelay.max)
  eventLoop.mean = ms(loopDelay.mean)
  eventLoop.sampledAt = now
  loopDelay.reset()
}

/** One durable job kind's pending rows (`done_at IS NULL`, running ones included) and the age of its oldest. */
export interface JobQueueDepth {
  kind: string
  pending: number
  oldestAgeSeconds: number
}

const JOB_KIND_LABEL = /^[a-z][a-z0-9_]{0,63}$/
const jobQueue: { rows: JobQueueDepth[]; sampledAt: number } = { rows: [], sampledAt: 0 }

/** Replaces the job-queue gauges with the rows sampler.ts read; a kind that is not an identifier is dropped. */
export function setJobQueue(rows: JobQueueDepth[], now = Date.now()): void {
  jobQueue.rows = rows
    .filter((r) => JOB_KIND_LABEL.test(r.kind))
    .map((r) => ({ kind: r.kind, pending: Math.max(0, Math.floor(r.pending)), oldestAgeSeconds: Math.max(0, r.oldestAgeSeconds) }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
  jobQueue.sampledAt = now
}

/** A value in the exposition format: JavaScript's shortest round-trip decimal; a NaN (no sample) reads 0. */
function num(v: number): string {
  return Number.isNaN(v) ? '0' : String(v)
}

function histogramLines(out: string[], name: string, label: string, entries: Array<[string, Histogram]>): void {
  out.push(`# HELP ${name} ${HELP[name]}`, `# TYPE ${name} histogram`)
  for (const [value, h] of entries) {
    let cumulative = 0
    for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
      cumulative += h.buckets[i]!
      const le = DURATION_BUCKETS_MS[i] === Infinity ? '+Inf' : num(DURATION_BUCKETS_MS[i]! / 1000)
      out.push(`${name}_bucket{${label}="${value}",le="${le}"} ${cumulative}`)
    }
    out.push(`${name}_sum{${label}="${value}"} ${num(h.sumMs / 1000)}`, `${name}_count{${label}="${value}"} ${h.count}`)
  }
}

const HELP: Record<string, string> = {
  elara_requests_total: 'HTTP requests finished since boot.',
  elara_request_server_errors_total: 'HTTP requests answered 5xx since boot.',
  elara_job_failures_total: 'Background jobs that failed (after their last attempt) since boot.',
  elara_jobs_total: 'Background job outcomes since boot, by monitoring kind: succeeded, failed, repeated (a failure of an item already failing).',
  elara_conflict_copies_total: 'Files the projector moved to .conflicts/ since boot.',
  elara_process_start_time_seconds: 'Process start, Unix time.',
  elara_process_resident_memory_bytes: 'Resident set size at the last sample.',
  elara_process_heap_used_bytes: 'V8 heap in use at the last sample.',
  elara_process_heap_total_bytes: 'V8 heap reserved at the last sample.',
  elara_process_external_memory_bytes: 'Memory of C++ objects bound to JS objects at the last sample.',
  elara_process_array_buffers_bytes: 'ArrayBuffer and SharedArrayBuffer memory at the last sample.',
  elara_process_memory_sample_timestamp_seconds: 'Unix time of the last process memory sample; 0 before the first.',
  elara_event_loop_lag_p50_seconds: 'Median event-loop delay over the last sample interval.',
  elara_event_loop_lag_p99_seconds: '99th percentile event-loop delay over the last sample interval.',
  elara_event_loop_lag_max_seconds: 'Longest event-loop delay over the last sample interval.',
  elara_event_loop_lag_mean_seconds: 'Mean event-loop delay over the last sample interval.',
  elara_event_loop_lag_sample_timestamp_seconds: 'Unix time of the last event-loop sample; 0 before the first.',
  elara_jobs_pending: 'Durable jobs not done (queued, running or in backoff) at the last sample, by jobs.kind.',
  elara_jobs_oldest_pending_age_seconds: 'Age of the oldest job not done at the last sample, by jobs.kind.',
  elara_jobs_sample_timestamp_seconds: 'Unix time of the last job-queue sample; 0 before the first.',
  elara_search_leg_duration_seconds: 'Duration of one search leg: its query (a keyword or vector leg), the query embedding, or the fusion of the rows.',
  elara_index_stage_duration_seconds: 'Duration of one extraction stage for one repository file: extract (parse and chunk), embed (new vectors only), write (the transaction).',
}

function gauge(out: string[], name: string, value: number, labels = ''): void {
  out.push(`# HELP ${name} ${HELP[name]}`, `# TYPE ${name} gauge`, `${name}${labels} ${num(value)}`)
}

function counter(out: string[], name: string, value: number): void {
  out.push(`# HELP ${name} ${HELP[name]}`, `# TYPE ${name} counter`, `${name} ${num(value)}`)
}

/** The Prometheus text exposition (format 0.0.4) of everything above. */
export function metricsText(): string {
  const out: string[] = []
  counter(out, 'elara_requests_total', totals.requests)
  counter(out, 'elara_request_server_errors_total', totals.serverErrors)
  counter(out, 'elara_job_failures_total', totals.jobFailures)
  out.push(`# HELP elara_jobs_total ${HELP.elara_jobs_total}`, '# TYPE elara_jobs_total counter')
  for (const kind of JOB_KINDS) {
    const j = jobs[kind]
    out.push(
      `elara_jobs_total{kind="${kind}",outcome="succeeded"} ${j.succeeded}`,
      `elara_jobs_total{kind="${kind}",outcome="failed"} ${j.failed}`,
      `elara_jobs_total{kind="${kind}",outcome="repeated"} ${j.repeated}`,
    )
  }
  counter(out, 'elara_conflict_copies_total', conflicts.copies)
  gauge(out, 'elara_process_start_time_seconds', Date.parse(bootInfo().startedAt) / 1000)
  gauge(out, 'elara_process_resident_memory_bytes', processMemory.rss)
  gauge(out, 'elara_process_heap_used_bytes', processMemory.heapUsed)
  gauge(out, 'elara_process_heap_total_bytes', processMemory.heapTotal)
  gauge(out, 'elara_process_external_memory_bytes', processMemory.external)
  gauge(out, 'elara_process_array_buffers_bytes', processMemory.arrayBuffers)
  gauge(out, 'elara_process_memory_sample_timestamp_seconds', processMemory.sampledAt / 1000)
  gauge(out, 'elara_event_loop_lag_p50_seconds', eventLoop.p50 / 1000)
  gauge(out, 'elara_event_loop_lag_p99_seconds', eventLoop.p99 / 1000)
  gauge(out, 'elara_event_loop_lag_max_seconds', eventLoop.max / 1000)
  gauge(out, 'elara_event_loop_lag_mean_seconds', eventLoop.mean / 1000)
  gauge(out, 'elara_event_loop_lag_sample_timestamp_seconds', eventLoop.sampledAt / 1000)
  out.push(`# HELP elara_jobs_pending ${HELP.elara_jobs_pending}`, '# TYPE elara_jobs_pending gauge')
  for (const r of jobQueue.rows) out.push(`elara_jobs_pending{kind="${r.kind}"} ${r.pending}`)
  out.push(`# HELP elara_jobs_oldest_pending_age_seconds ${HELP.elara_jobs_oldest_pending_age_seconds}`, '# TYPE elara_jobs_oldest_pending_age_seconds gauge')
  for (const r of jobQueue.rows) out.push(`elara_jobs_oldest_pending_age_seconds{kind="${r.kind}"} ${num(r.oldestAgeSeconds)}`)
  gauge(out, 'elara_jobs_sample_timestamp_seconds', jobQueue.sampledAt / 1000)
  histogramLines(
    out,
    'elara_search_leg_duration_seconds',
    'leg',
    SEARCH_LEGS.map((l) => [l, searchLegs[l]]),
  )
  histogramLines(
    out,
    'elara_index_stage_duration_seconds',
    'stage',
    INDEX_STAGES.map((s) => [s, indexStages[s]]),
  )
  return out.join('\n') + '\n'
}

/** Test-only view of one histogram: raw (non-cumulative) bucket counts. */
export interface HistogramCounts {
  count: number
  sumMs: number
  buckets: number[]
}

/** Test-only: the raw counts behind the exposition. */
export function instrumentSnapshot() {
  const hist = (h: Histogram): HistogramCounts => ({ count: h.count, sumMs: h.sumMs, buckets: Array.from(h.buckets) })
  return {
    processMemory: { ...processMemory },
    eventLoop: { ...eventLoop },
    jobQueue: { rows: jobQueue.rows.map((r) => ({ ...r })), sampledAt: jobQueue.sampledAt },
    searchLegs: Object.fromEntries(SEARCH_LEGS.map((l) => [l, hist(searchLegs[l])])) as Record<SearchLeg, HistogramCounts>,
    indexStages: Object.fromEntries(INDEX_STAGES.map((s) => [s, hist(indexStages[s])])) as Record<IndexStage, HistogramCounts>,
  }
}

/** Test-only: forget every instrument observation and sample (the counters go with `resetMetrics`). */
export function resetInstruments(): void {
  for (const l of SEARCH_LEGS) searchLegs[l] = histogram()
  for (const s of INDEX_STAGES) indexStages[s] = histogram()
  Object.assign(processMemory, { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0, sampledAt: 0 })
  Object.assign(eventLoop, { p50: 0, p99: 0, max: 0, mean: 0, sampledAt: 0 })
  jobQueue.rows = []
  jobQueue.sampledAt = 0
}
