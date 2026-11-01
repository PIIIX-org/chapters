import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  DURATION_BUCKETS_MS,
  INDEX_STAGES,
  MAX_ERRORS,
  MAX_ROUTES,
  SEARCH_LEGS,
  WINDOW_MINUTES,
  errorInfo,
  instrumentSnapshot,
  metricsSnapshot,
  metricsText,
  observeIndexStage,
  observeSearchLeg,
  recordJob,
  recordRequest,
  resetInstruments,
  resetMetrics,
  routeKey,
  sampleEventLoop,
  sampleProcessMemory,
  setJobQueue,
  startEventLoopMonitor,
  stopEventLoopMonitor,
  type RequestSample,
} from '../src/monitoring/metrics.js'

// The in-process store behind GET /api/admin/monitoring (#705): bounded in
// routes, time and error records, and nothing free-text gets in.

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0)
const sample = (over: Partial<RequestSample> = {}): RequestSample => ({
  method: 'GET',
  template: '/api/vaults/:id',
  status: 200,
  durationMs: 10,
  reqId: 'req-1',
  actor: 'user',
  ...over,
})

let errorSpy: MockInstance<typeof console.error>
beforeEach(() => {
  resetMetrics()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('monitoring metrics (#705)', () => {
  it('keeps the class name and code of an error, never its message', () => {
    const err = Object.assign(new Error('EACCES: permission denied, open /data/vaults/x/secret-note.md'), { code: 'EACCES' })
    expect(errorInfo(err)).toEqual({ name: 'Error', code: 'EACCES' })
    expect(errorInfo(Object.assign(new TypeError('x'), { code: 42 }))).toEqual({ name: 'TypeError', code: '42' })
    expect(errorInfo({ name: 'note text with spaces', code: 'has spaces too' })).toEqual({ name: null, code: null })
    expect(errorInfo('a thrown string')).toEqual({ name: null, code: null })
    expect(errorInfo(null)).toEqual({ name: null, code: null })
  })

  it('keys routes by method and template; anything else is (other)', () => {
    expect(routeKey('GET', '/api/vaults/:id/notes/*')).toBe('GET /api/vaults/:id/notes/*')
    expect(routeKey('GET', undefined)).toBe('GET (other)')
    expect(routeKey('BREW', '/x')).toBe('OTHER /x')
    expect(routeKey('GET', '/a b?q=secret')).toBe('GET (other)')
  })

  it('reports percentiles as bucket upper bounds capped at the max, per route over the window', () => {
    for (let i = 0; i < 95; i++) recordRequest(sample({ durationMs: 8 }), T0)
    for (let i = 0; i < 5; i++) recordRequest(sample({ durationMs: 1800 }), T0)
    const [route] = metricsSnapshot(T0).routes
    expect(route).toEqual({ route: 'GET /api/vaults/:id', count: 100, serverErrors: 0, p50Ms: 10, p95Ms: 10, p99Ms: 1800, maxMs: 1800 })
  })

  it('counts a 5xx as an error report with request id, route, actor and status; totals survive the window', () => {
    recordRequest(sample({ status: 503, reqId: 'req-7', actor: 'token', error: new Error('note body here') }), T0)
    recordRequest(sample({ status: 404, reqId: 'bad id with spaces' }), T0)
    const snap = metricsSnapshot(T0)
    expect(snap.totals).toEqual({ requests: 2, serverErrors: 1, jobFailures: 0 })
    expect(snap.errors).toEqual([
      {
        seq: 1,
        at: new Date(T0).toISOString(),
        type: 'request',
        reqId: 'req-7',
        route: 'GET /api/vaults/:id',
        status: 503,
        durationMs: 10,
        actor: 'token',
        error: { name: 'Error', code: null },
      },
    ])
    const later = metricsSnapshot(T0 + WINDOW_MINUTES * 60_000)
    expect(later.routes).toEqual([])
    expect(later.totals.serverErrors).toBe(1)
    expect(later.errors).toHaveLength(1)
  })

  it('drops a subject that is not a UUID and counts job successes and failures per kind', () => {
    recordJob('sync', 'ok', '019a1c00-0000-7000-8000-000000000001', T0)
    recordJob('sync', { error: new Error('clone https://x-access-token:ghp_x@host/repo failed') }, 'docs/my note', T0)
    const snap = metricsSnapshot(T0)
    expect(snap.jobs.sync).toEqual({ succeeded: 1, failed: 1, repeated: 0 })
    expect(snap.totals.jobFailures).toBe(1)
    expect(snap.errors).toEqual([
      { seq: 1, at: new Date(T0).toISOString(), type: 'job', job: 'sync', subjectId: null, error: { name: 'Error', code: null } },
    ])
    expect(JSON.parse(String(errorSpy.mock.calls[0]![0]))).toMatchObject({ event: 'job_failure', job: 'sync' })
  })

  it('counts a repeat failure (a subject already failing) only as repeated: no total, no record, no log line', () => {
    recordJob('sync', { error: new Error('x') }, null, T0)
    recordJob('sync', { error: new Error('x'), repeat: true }, null, T0)
    recordJob('sync', { error: new Error('x'), repeat: true }, null, T0)
    const snap = metricsSnapshot(T0)
    expect(snap.jobs.sync).toEqual({ succeeded: 0, failed: 1, repeated: 2 })
    expect(snap.totals.jobFailures).toBe(1)
    expect(snap.errors).toHaveLength(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps the last MAX_ERRORS records and at most MAX_ROUTES route keys', () => {
    for (let i = 0; i < MAX_ERRORS + 10; i++) recordJob('embedding', { error: new Error('x') }, null, T0)
    const snap = metricsSnapshot(T0)
    expect(snap.errors).toHaveLength(MAX_ERRORS)
    expect(snap.errors[0]!.seq).toBe(11)
    expect(snap.lastSeq).toBe(MAX_ERRORS + 10)

    for (let i = 0; i < MAX_ROUTES + 20; i++) recordRequest(sample({ template: `/api/r${i}` }), T0)
    const routes = metricsSnapshot(T0).routes
    expect(routes).toHaveLength(MAX_ROUTES + 1)
    expect(routes.find((r) => r.route === 'GET (other)')?.count).toBe(20)
  })
})

/** The value of the sample `name{labels}` in a scrape, or undefined when the series is absent. */
function series(text: string, name: string, labels = ''): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${name}${labels} `))
  return line === undefined ? undefined : Number(line.slice(name.length + labels.length + 1))
}

describe('Prometheus exposition (GET /api/admin/metrics)', () => {
  beforeEach(() => resetInstruments())
  afterEach(() => stopEventLoopMonitor())

  it('exports the boot counters as counters, every job kind by outcome', () => {
    recordRequest(sample({ durationMs: 8 }), T0)
    recordRequest(sample({ status: 500 }), T0)
    recordJob('embedding', 'ok')
    recordJob('sync', { error: new Error('x') })
    recordJob('sync', { error: new Error('x'), repeat: true })
    const text = metricsText()
    expect(text).toContain('# TYPE elara_requests_total counter')
    expect(series(text, 'elara_requests_total')).toBe(2)
    expect(series(text, 'elara_request_server_errors_total')).toBe(1)
    expect(series(text, 'elara_job_failures_total')).toBe(1)
    expect(series(text, 'elara_jobs_total', '{kind="embedding",outcome="succeeded"}')).toBe(1)
    expect(series(text, 'elara_jobs_total', '{kind="sync",outcome="failed"}')).toBe(1)
    expect(series(text, 'elara_jobs_total', '{kind="sync",outcome="repeated"}')).toBe(1)
    expect(series(text, 'elara_jobs_total', '{kind="backup",outcome="failed"}')).toBe(0)
    expect(text.endsWith('\n')).toBe(true)
    // Every sample line names a metric that has a HELP and a TYPE line.
    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue
      const name = /^([a-z0-9_]+)(?:\{| )/.exec(line)![1]!.replace(/_(bucket|sum|count)$/, '')
      expect(text, line).toContain(`# TYPE ${name} `)
    }
  })

  it('exports a histogram per search leg and per extraction stage with cumulative buckets in seconds', () => {
    observeSearchLeg('note_keyword', 3)
    observeSearchLeg('note_keyword', 30)
    observeSearchLeg('note_keyword', 70_000)
    observeSearchLeg('note_keyword', Number.NaN)
    observeIndexStage('write', 12)
    const text = metricsText()
    expect(text).toContain('# TYPE elara_search_leg_duration_seconds histogram')
    expect(series(text, 'elara_search_leg_duration_seconds_bucket', '{leg="note_keyword",le="0.001"}')).toBe(1)
    expect(series(text, 'elara_search_leg_duration_seconds_bucket', '{leg="note_keyword",le="0.005"}')).toBe(2)
    expect(series(text, 'elara_search_leg_duration_seconds_bucket', '{leg="note_keyword",le="0.05"}')).toBe(3)
    expect(series(text, 'elara_search_leg_duration_seconds_bucket', '{leg="note_keyword",le="60"}')).toBe(3)
    expect(series(text, 'elara_search_leg_duration_seconds_bucket', '{leg="note_keyword",le="+Inf"}')).toBe(4)
    expect(series(text, 'elara_search_leg_duration_seconds_count', '{leg="note_keyword"}')).toBe(4)
    expect(series(text, 'elara_search_leg_duration_seconds_sum', '{leg="note_keyword"}')).toBeCloseTo(70.033, 6)
    for (const leg of SEARCH_LEGS) expect(series(text, 'elara_search_leg_duration_seconds_count', `{leg="${leg}"}`)).toBe(leg === 'note_keyword' ? 4 : 0)
    for (const stage of INDEX_STAGES) expect(series(text, 'elara_index_stage_duration_seconds_count', `{stage="${stage}"}`)).toBe(stage === 'write' ? 1 : 0)
    expect(series(text, 'elara_index_stage_duration_seconds_bucket', '{stage="write",le="0.01"}')).toBe(0)
    expect(series(text, 'elara_index_stage_duration_seconds_bucket', '{stage="write",le="0.025"}')).toBe(1)
    expect(instrumentSnapshot().searchLegs.note_keyword.buckets).toHaveLength(DURATION_BUCKETS_MS.length)
  })

  it('samples process memory into gauges, zero before the first sample', () => {
    expect(series(metricsText(), 'elara_process_resident_memory_bytes')).toBe(0)
    expect(series(metricsText(), 'elara_process_memory_sample_timestamp_seconds')).toBe(0)
    sampleProcessMemory(T0)
    const text = metricsText()
    expect(series(text, 'elara_process_resident_memory_bytes')).toBeGreaterThan(1_000_000)
    expect(series(text, 'elara_process_heap_used_bytes')).toBeGreaterThan(0)
    expect(series(text, 'elara_process_heap_total_bytes')).toBeGreaterThanOrEqual(series(text, 'elara_process_heap_used_bytes')!)
    expect(series(text, 'elara_process_external_memory_bytes')).toBeGreaterThan(0)
    expect(series(text, 'elara_process_array_buffers_bytes')).toBeGreaterThanOrEqual(0)
    expect(series(text, 'elara_process_memory_sample_timestamp_seconds')).toBe(T0 / 1000)
    expect(series(text, 'elara_process_start_time_seconds')).toBeGreaterThan(1_700_000_000)
  })

  // Real time on purpose: `monitorEventLoopDelay` measures the platform's event loop, which fake timers do not drive.
  it('reports event-loop lag percentiles over the interval since the previous sample', async () => {
    sampleEventLoop(T0)
    expect(instrumentSnapshot().eventLoop.sampledAt, 'no-op before the monitor starts').toBe(0)
    startEventLoopMonitor()
    // The monitor measures from its first tick: let it take one before the loop is held.
    await sleep(30)
    const until = Date.now() + 80
    while (Date.now() < until) {
      /* a busy loop of 80 ms: the delay monitor sees at least one late tick */
    }
    await sleep(30)
    sampleEventLoop(T0)
    const text = metricsText()
    expect(series(text, 'elara_event_loop_lag_max_seconds')).toBeGreaterThan(0.05)
    expect(series(text, 'elara_event_loop_lag_p99_seconds')).toBeGreaterThan(0)
    expect(series(text, 'elara_event_loop_lag_p50_seconds')).toBeLessThanOrEqual(series(text, 'elara_event_loop_lag_p99_seconds')!)
    expect(series(text, 'elara_event_loop_lag_mean_seconds')).toBeGreaterThan(0)
    expect(series(text, 'elara_event_loop_lag_sample_timestamp_seconds')).toBe(T0 / 1000)
    // Reset after the sample: a quiet interval reports a small lag again, not the busy loop's maximum.
    await sleep(40)
    sampleEventLoop(T0 + 15_000)
    expect(series(metricsText(), 'elara_event_loop_lag_max_seconds')).toBeLessThan(0.05)
  })

  it('exports job-queue depth and oldest age per kind, sorted, dropping a kind that is not an identifier', () => {
    setJobQueue(
      [
        { kind: 'extract', pending: 12, oldestAgeSeconds: 90.5 },
        { kind: 'embed_note', pending: 3, oldestAgeSeconds: 2 },
        { kind: 'bad kind; with text', pending: 1, oldestAgeSeconds: 1 },
        { kind: 'store_note', pending: 0, oldestAgeSeconds: -1 },
      ],
      T0,
    )
    const text = metricsText()
    expect(series(text, 'elara_jobs_pending', '{kind="extract"}')).toBe(12)
    expect(series(text, 'elara_jobs_pending', '{kind="embed_note"}')).toBe(3)
    expect(series(text, 'elara_jobs_oldest_pending_age_seconds', '{kind="extract"}')).toBe(90.5)
    expect(series(text, 'elara_jobs_oldest_pending_age_seconds', '{kind="store_note"}')).toBe(0)
    expect(text).not.toContain('bad kind')
    expect(text.indexOf('elara_jobs_pending{kind="embed_note"}')).toBeLessThan(text.indexOf('elara_jobs_pending{kind="extract"}'))
    expect(series(text, 'elara_jobs_sample_timestamp_seconds')).toBe(T0 / 1000)
    expect(instrumentSnapshot().jobQueue.rows.map((r) => r.kind)).toEqual(['embed_note', 'extract', 'store_note'])
  })
})
