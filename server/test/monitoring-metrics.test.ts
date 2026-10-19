import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  MAX_ERRORS,
  MAX_ROUTES,
  WINDOW_MINUTES,
  errorInfo,
  metricsSnapshot,
  recordJob,
  recordRequest,
  resetMetrics,
  routeKey,
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
