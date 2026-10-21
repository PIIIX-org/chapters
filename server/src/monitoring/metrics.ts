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

import { bootInfo } from '../lifecycle.js'

export const WINDOW_MINUTES = 15
export const MAX_ROUTES = 300
export const MAX_ERRORS = 50
/** Upper bounds (ms) of the latency buckets; percentiles report the bucket's bound, capped at the max seen. */
export const LATENCY_BUCKETS_MS = [
  1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000,
  4000, 5000, 7500, 10_000, 15_000, 20_000, 30_000, 60_000, Infinity,
]
export const JOB_KINDS = ['embedding', 'extraction', 'sync', 'collab-store', 'backup', 'projection'] as const
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
}
