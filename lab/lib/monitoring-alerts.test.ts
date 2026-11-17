// Exercise the real lab consumer, not its source text or a copied readiness predicate.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import monitoringAlerts from '../tests/monitoring-alerts.test.ts'
import type { LabContext } from './context.ts'

test('monitor snapshots wait for the injected sync and projection, not initial idle or older failures', async (t) => {
  const noteId = '11111111-1111-4111-8111-111111111111'
  const repoId = '22222222-2222-4222-8222-222222222222'
  const jobs = { projection: { failed: 2 }, sync: { failed: 3 } }
  const errors: Array<{ type: string; job?: string; subjectId?: string; route?: string; status?: number }> = [
    { type: 'job', job: 'projection', subjectId: 'old-note' },
    { type: 'job', job: 'sync', subjectId: 'old-repo' },
  ]
  const syncStates: string[] = []
  const snapshots: Array<{ sync: string; projectionPending: boolean }> = []
  const intervals: number[] = []
  let syncStatus = 'idle'
  let syncRead = 0
  let syncCounted = false
  let projectionRead = 0
  let projectionInjected = false
  let projectionCounted = false
  let projectionPending = false
  let pendingRead = 0
  let repairPendingReads = 0
  let monitorRuns = 0
  let seenReports = errors.length
  let sinkFetch: (req: Request) => Promise<Response>
  const fail = (job: keyof typeof jobs, subjectId: string) => {
    jobs[job].failed++
    errors.push({ type: 'job', job, subjectId })
  }
  const metrics = () => {
    if (projectionInjected && !projectionCounted && ++projectionRead === 2) {
      fail('projection', noteId)
      projectionCounted = true
    }
    // Publish error before its accounting becomes visible: neither signal alone is enough.
    if (syncStatus === 'error' && !syncCounted && syncRead >= 4) {
      fail('sync', repoId)
      syncCounted = true
    }
    return { jobs, errors }
  }
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/health')) {
      return Response.json({ bootId: 'boot', lastShutdown: null, previousBootId: null, startedAt: '', status: 'ok', version: '' })
    }
    if (url.includes('/api/admin/monitoring')) {
      if (!init?.headers) return new Response('', { status: 401 })
      return Response.json(metrics())
    }
    if (url.includes('/assets')) {
      if (url.includes('?')) errors.push({ type: 'request', route: 'POST /api/vaults/:id/assets', status: 500 })
      return new Response('', { status: url.includes('?') ? 500 : 200 })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  const oldBun = Reflect.get(globalThis, 'Bun')
  const oldToken = process.env.ELARA_MONITORING_TOKEN
  process.env.ELARA_MONITORING_TOKEN = 'test-token'
  t.after(() => {
    if (oldBun === undefined) Reflect.deleteProperty(globalThis, 'Bun')
    else Reflect.set(globalThis, 'Bun', oldBun)
    if (oldToken === undefined) delete process.env.ELARA_MONITORING_TOKEN
    else process.env.ELARA_MONITORING_TOKEN = oldToken
  })
  Reflect.set(globalThis, 'Bun', {
    serve(opts: { fetch: typeof sinkFetch }) {
      sinkFetch = opts.fetch
      return { port: 12345, stop() {} }
    },
    async sleep(ms: number) {
      intervals.push(ms) // Advance the scripted responses, never the wall clock.
      assert.ok(intervals.length < 20, 'completion barrier must make progress')
    },
    spawn() {
      const run = monitorRuns++
      if (run >= 2) snapshots.push({ sync: syncStatus, projectionPending })
      const recent = run >= 2 ? errors.slice(seenReports) : []
      if (run >= 1) seenReports = errors.length
      const alerts = [
        ...(recent.some((e) => e.type === 'request') ? [{ kind: 'errors', recent: recent.filter((e) => e.type === 'request') }] : []),
        ...(recent.some((e) => e.type === 'job') ? [{ kind: 'jobs', recent: recent.filter((e) => e.type === 'job') }] : []),
      ]
      const done = alerts.length ? sinkFetch(new Request('http://sink/hook', { method: 'POST', body: JSON.stringify({ text: '', alerts }) })) : Promise.resolve()
      return {
        stdout: new ReadableStream({
          async start(controller) {
            await done
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ metrics: run === 0 ? { skipped: 'unset' } : { ok: true }, alerts })))
            controller.close()
          },
        }),
        stderr: '',
        exited: done.then(() => 0),
      }
    },
  })
  const admin = {
    cookie: 'test-session',
    async must(method: string, path: string) {
      if (method === 'POST' && path.endsWith('/notes')) return { id: noteId }
      if (method === 'POST' && path === '/api/repositories') return { id: repoId }
      if (method === 'GET' && path === '/api/repositories') {
        syncStatus = ['idle', 'syncing', 'error', 'error'][Math.min(syncRead++, 3)]!
        syncStates.push(syncStatus)
        return [{ id: repoId, syncStatus }]
      }
      throw new Error(`unexpected request ${method} ${path}`)
    },
    async request(_method: string, path: string) {
      if (path.includes('?')) projectionInjected = true
      else {
        projectionPending = true
        pendingRead = 0
      }
      return { status: 200 }
    },
  }
  const ctx = {
    baseUrl: 'http://lab.invalid',
    uniq: (s: string) => s,
    rest: () => admin,
    createVault: async () => ({ id: '33333333-3333-4333-8333-333333333333' }),
    docker: {
      appExec: async () => ({ code: 0, stdout: '', stderr: '' }),
      async psql() {
        if (projectionPending) {
          repairPendingReads++
          // Another projection from the same PUT finishes after its file failure.
          if (pendingRead++ === 0) {
            fail('projection', noteId)
            return '1'
          }
          projectionPending = false
        }
        return '0'
      },
      app: { logs: async () => '{"event":"server_error"}\n{"event":"job_failure"}' },
    },
  } as unknown as LabContext
  const result = await monitoringAlerts.run(ctx)
  assert.deepEqual(syncStates, ['idle', 'syncing', 'error', 'error'])
  assert.deepEqual(snapshots, [
    { sync: 'error', projectionPending: false },
    { sync: 'error', projectionPending: false },
  ])
  assert.ok(projectionCounted, 'the injected note, not an older failure, must complete')
  assert.ok(syncCounted, 'error status must be accompanied by new sync failure accounting')
  assert.equal(repairPendingReads, 2, 'drain the repaired note before taking either monitor snapshot')
  assert.deepEqual(result.checks.filter((c) => !c.ok), [])
})
