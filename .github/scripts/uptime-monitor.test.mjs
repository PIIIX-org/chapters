// Unit tests for the pure parts of uptime-monitor.mjs (#583).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DOWN_AFTER,
  HEARTBEAT_MS,
  METRICS_DEFAULTS,
  METRICS_PATH,
  UNCLEAN_LABEL,
  emptyState,
  formatComment,
  labelsFor,
  metricsOptions,
  normalizeUrl,
  observe,
  observeMetrics,
  parseArgs,
  readStates,
  step,
  stepMetrics,
  webhookPayload,
  webhookTarget,
  writeStates,
} from './uptime-monitor.mjs'

const URL = 'https://chapters.piiix.org'
const A = '019a1c00-0000-7000-8000-000000000001'
const B = '019a1c10-0000-7000-8000-000000000002'
const C = '019a1c20-0000-7000-8000-000000000003'
const T1 = '2026-10-16T09:00:00.000Z'
const T2 = '2026-10-16T09:30:00.000Z'
const V1 = 'aaaaaaa1'
const V2 = 'bbbbbbb2'
let minute = 0
const at = () => new Date(Date.UTC(2026, 9, 16, 10, minute++)).toISOString()
const up = (bootId, over = {}) =>
  observe({
    at: at(),
    status: 200,
    body: { status: 'ok', bootId, startedAt: T1, version: 'abc1234', lastShutdown: 'graceful', previousBootId: null, ...over },
  })
const fail = (error = 'ECONNREFUSED') => observe({ at: at(), error })

/** Runs observations through step() in order: [{state, alerts}] per run. */
function run(observations, state = emptyState()) {
  return observations.map((obs) => {
    const r = step(state, obs)
    state = r.state
    return r
  })
}

describe('observe', () => {
  it('reads the identity fields of a new payload', () => {
    const o = up(A, { lastShutdown: 'unclean', previousBootId: C })
    assert.equal(o.ok, true)
    assert.deepEqual(o.health, { bootId: A, startedAt: T1, version: 'abc1234', lastShutdown: 'unclean', previousBootId: C })
  })
  it('treats the old payload ({status: ok} only) as up with unknown identity', () => {
    const o = observe({ at: at(), status: 200, body: { status: 'ok' } })
    assert.equal(o.ok, true)
    assert.deepEqual(o.health, { bootId: null, startedAt: null, version: null, lastShutdown: null, previousBootId: null })
  })
  it('is down on a network error, a non-2xx status (503: database unreachable) or a body that is not ok', () => {
    assert.equal(fail().ok, false)
    assert.equal(observe({ at: at(), status: 503, body: { status: 'error' } }).error, 'HTTP 503')
    assert.equal(observe({ at: at(), status: 200, body: null }).ok, false)
    assert.equal(observe({ at: at(), status: 200, body: { status: 'starting' } }).ok, false)
  })
  it('drops an unrecognised lastShutdown value', () => {
    assert.equal(up(A, { lastShutdown: 'exploded' }).health.lastShutdown, null)
  })
  it('drops identity values with an unexpected format, so they never reach a comment', () => {
    const o = up('` | @owner [x](https://evil) |', {
      startedAt: '2026-10-16T09:00:00Z <img>',
      version: '`@owner`',
      previousBootId: 'not-a-uuid',
    })
    assert.deepEqual(o.health, { bootId: null, startedAt: null, version: null, lastShutdown: 'graceful', previousBootId: null })
    assert.equal(up(A, { startedAt: '2026-13-45T99:99:99Z' }).health.startedAt, null, 'shape right, not a date')
    assert.equal(up(A, { version: 'A'.repeat(40) }).health.version, null, 'hex in lower case only')
    assert.equal(up(A, { version: 'f'.repeat(41) }).health.version, null)
  })
  it('keeps only plain characters of error text', () => {
    assert.equal(observe({ at: at(), error: 'boom `@owner` [x](y)\n| z' }).error, 'boom ??owner? ?x?(y)?? z')
    assert.equal(observe({ at: at(), status: 200, body: { status: '`@owner`' } }).error, 'status ???owner??')
    assert.ok(observe({ at: at(), error: 'x'.repeat(500) }).error.length <= 160)
  })
})

describe('step: restarts', () => {
  it('records the first bootId it sees without alerting (baseline)', () => {
    const [r] = run([up(A)])
    assert.deepEqual(r.alerts, [])
    assert.equal(r.state.bootId, A)
  })
  it('does not alert while the bootId stays the same', () => {
    const rs = run([up(A), up(A), up(A)])
    assert.deepEqual(rs.flatMap((r) => r.alerts), [])
    assert.deepEqual(rs[1].state, rs[2].state, 'state does not change, so the issue body is not rewritten')
  })
  it('alerts once when the bootId changes, with old and new startedAt, version and lastShutdown', () => {
    const rs = run([
      up(A, { startedAt: T1, version: V1 }),
      up(B, { startedAt: T2, version: V2, lastShutdown: 'graceful', previousBootId: A }),
      up(B),
    ])
    assert.equal(rs[1].alerts.length, 1)
    const [alert] = rs[1].alerts
    assert.equal(alert.kind, 'restart')
    assert.deepEqual(alert.previous, { bootId: A, startedAt: T1, version: V1 })
    assert.deepEqual(alert.current, { bootId: B, startedAt: T2, version: V2 })
    assert.equal(alert.lastShutdown, 'graceful')
    assert.equal(alert.unseen, false)
    assert.deepEqual(labelsFor(rs[1].alerts), [])
    assert.deepEqual(rs[2].alerts, [], 'the same restart is not reported twice')
  })
  it('labels an unclean restart', () => {
    const rs = run([up(A), up(B, { lastShutdown: 'unclean', previousBootId: A })])
    assert.equal(rs[1].alerts[0].lastShutdown, 'unclean')
    assert.deepEqual(labelsFor(rs[1].alerts), [UNCLEAN_LABEL])
  })
  it('flags a lastShutdown about a process it never saw (two restarts between checks)', () => {
    // A crashed, C started and was restarted gracefully, B is up: B's
    // lastShutdown (graceful) is about C, not about A.
    const rs = run([up(A), up(B, { lastShutdown: 'graceful', previousBootId: C })])
    const [alert] = rs[1].alerts
    assert.equal(alert.unseen, true)
    assert.equal(alert.previousBootId, C)
    const md = formatComment(rs[1].alerts, URL)
    assert.match(md, /More than one restart since the last check/)
    assert.match(md, new RegExp(`how that one ended is not known`))
    assert.match(md, new RegExp(`lastShutdown \\*\\*graceful\\*\\* is about \`${C}\``))
  })
  it('does not flag when the previous bootId is unknown (lastShutdown unknown)', () => {
    const rs = run([up(A), up(B, { lastShutdown: 'unknown', previousBootId: null })])
    assert.equal(rs[1].alerts[0].unseen, false)
  })
  it('never alerts on the old payload, however often it is seen (no bootId = unknown)', () => {
    const old = () => observe({ at: at(), status: 200, body: { status: 'ok' } })
    const rs = run([old(), old(), old()])
    assert.deepEqual(rs.flatMap((r) => r.alerts), [])
    assert.deepEqual(rs[1].state, rs[2].state)
  })
  it('takes the first new payload after the old one as a baseline (the promotion that ships #583)', () => {
    const rs = run([observe({ at: at(), status: 200, body: { status: 'ok' } }), up(A), up(A)])
    assert.deepEqual(rs.flatMap((r) => r.alerts), [])
    assert.equal(rs[2].state.bootId, A)
  })
  it('reads a state saved by an older monitor version (missing fields)', () => {
    const r = step({ bootId: A }, up(B))
    assert.equal(r.alerts[0].kind, 'restart')
  })
  it('re-checks the saved state before it reaches a comment (the issue body can be edited by hand)', () => {
    const saved = { ...emptyState(), bootId: A, startedAt: '2026-10-16T09:00:00Z <img>', version: '`@owner` [x](https://evil)' }
    const r = step(saved, up(B, { previousBootId: A }))
    assert.deepEqual(r.alerts[0].previous, { bootId: A, startedAt: null, version: null })
    const md = formatComment(r.alerts, URL)
    assert.doesNotMatch(md, /@owner|evil|<img>/)
    assert.match(md, /\| version \| _none_ \| `abc1234` \|/)
  })
  it('takes a hand-edited saved bootId as no baseline: no alert, the observed identity is saved', () => {
    const r = step({ ...emptyState(), bootId: '` | @owner [x](https://evil) |' }, up(B))
    assert.deepEqual(r.alerts, [])
    assert.equal(r.state.bootId, B)
  })
  it('resets hand-edited outage and heartbeat fields instead of printing them', () => {
    const t = '2026-10-16T08:00:00.000Z'
    const saved = { ...emptyState(), bootId: A, failures: '1', firstFailureAt: '@owner', down: 'yes', heartbeatAt: '[x](https://evil)' }
    const r = step(saved, fail())
    assert.deepEqual(r.alerts, [], 'failures reset to 0: one failure is not an outage')
    assert.equal(r.state.failures, 1)
    assert.equal(r.state.down, false)
    assert.equal(r.state.firstFailureAt, r.state.heartbeatAt, 'both restart from this check')
    const down = step({ ...emptyState(), bootId: A, failures: 1, firstFailureAt: '`@owner`', heartbeatAt: t }, fail())
    assert.doesNotMatch(formatComment(down.alerts, URL), /@owner/)
  })
  it('resets saved monitor timestamps later than now, so a hand-edited heartbeatAt cannot stop the check-in', () => {
    const future = '2099-01-01T00:00:00.000Z'
    const now = up(A)
    const r = step({ ...emptyState(), bootId: A, heartbeatAt: future }, now)
    assert.equal(r.state.heartbeatAt, now.at, 'the clock restarts from this check')
    const week = step(r.state, { ...up(A), at: new Date(Date.parse(r.state.heartbeatAt) + HEARTBEAT_MS).toISOString() })
    assert.deepEqual(week.alerts.map((a) => a.kind), ['heartbeat'])
    const down = step({ ...emptyState(), bootId: A, failures: 1, firstFailureAt: future, heartbeatAt: future }, fail())
    assert.equal(down.alerts[0].kind, 'down')
    assert.notEqual(down.alerts[0].since, future)
    assert.equal(down.alerts[0].since, down.alerts[0].at)
  })
})

describe('step: down and recovery', () => {
  it('needs two failures in a row: one failure followed by success alerts nothing', () => {
    const rs = run([up(A), fail(), up(A)])
    assert.deepEqual(rs.flatMap((r) => r.alerts), [])
    assert.deepEqual(rs[2].state, rs[0].state)
  })
  it(`alerts once after ${DOWN_AFTER} failures, never again while it stays down, and once on recovery`, () => {
    const rs = run([up(A), fail(), fail('timeout'), fail(), fail(), up(A), up(A)])
    const kinds = rs.map((r) => r.alerts.map((a) => a.kind))
    assert.deepEqual(kinds, [[], [], ['down'], [], [], ['recovered'], []])
    assert.equal(rs[2].alerts[0].since, rs[1].state.firstFailureAt)
    assert.equal(rs[2].alerts[0].error, 'timeout')
    assert.deepEqual(rs[3].state, rs[4].state, 'state is constant while down: no body rewrite per run')
    assert.equal(rs[5].alerts[0].since, rs[2].alerts[0].since)
  })
  it('reports a restart during the outage together with the recovery', () => {
    const rs = run([up(A), fail(), fail(), up(B, { lastShutdown: 'unclean', previousBootId: A })])
    assert.deepEqual(rs[3].alerts.map((a) => a.kind), ['recovered', 'restart'])
    assert.deepEqual(labelsFor(rs[3].alerts), [UNCLEAN_LABEL])
  })
  it('keeps the last seen identity while down, so the restart is still compared', () => {
    const rs = run([up(A), fail(), fail(), fail()])
    assert.equal(rs[3].state.bootId, A)
  })
})

describe('step: weekly heartbeat', () => {
  const t0 = Date.UTC(2026, 9, 1)
  const iso = (ms) => new Date(ms).toISOString()
  const upAt = (ms, bootId = A) => ({ ...up(bootId), at: iso(ms) })

  it('starts the clock on the first check, posts once a week, and never in between', () => {
    const rs = run([
      upAt(t0),
      upAt(t0 + HEARTBEAT_MS - 60_000),
      upAt(t0 + HEARTBEAT_MS),
      upAt(t0 + HEARTBEAT_MS + 600_000),
      upAt(t0 + 2 * HEARTBEAT_MS),
    ])
    assert.deepEqual(
      rs.map((r) => r.alerts.map((a) => a.kind)),
      [[], [], ['heartbeat'], [], ['heartbeat']],
    )
    assert.equal(rs[0].state.heartbeatAt, iso(t0))
    assert.equal(rs[2].alerts[0].since, iso(t0))
    assert.equal(rs[2].state.heartbeatAt, iso(t0 + HEARTBEAT_MS))
    assert.deepEqual(rs[0].state, rs[1].state, 'no state change between heartbeats: no body rewrite')
  })
  it('also posts while down, and says so', () => {
    const rs = run([upAt(t0), { ...fail('ETIMEDOUT'), at: iso(t0 + 1) }, { ...fail('ETIMEDOUT'), at: iso(t0 + HEARTBEAT_MS) }])
    const hb = rs[2].alerts.find((a) => a.kind === 'heartbeat')
    assert.equal(hb.ok, false)
    assert.match(formatComment([hb], URL), /`\/health` is failing \(`ETIMEDOUT`\)/)
  })
  it('names the monitor as the thing to check when it stops', () => {
    const rs = run([upAt(t0), upAt(t0 + HEARTBEAT_MS)])
    const md = formatComment(rs[1].alerts, URL)
    assert.match(md, /### Weekly check-in: https:\/\/chapters\.piiix\.org/)
    assert.match(md, /If this weekly comment stops coming, the monitor itself is broken/)
    assert.match(md, new RegExp(`bootId \`${A}\``))
  })
})

describe('formatComment', () => {
  it('names the URL, both startedAt and versions, and explains lastShutdown', () => {
    const [, r] = run([
      up(A, { startedAt: T1, version: V1 }),
      up(B, { startedAt: T2, version: V2, lastShutdown: 'unclean', previousBootId: A }),
    ])
    const md = formatComment(r.alerts, URL)
    assert.match(md, /### Restart: https:\/\/chapters\.piiix\.org/)
    assert.match(md, new RegExp(`\\| startedAt \\| \`${T1}\` \\| \`${T2}\` \\|`))
    assert.match(md, new RegExp(`\\| version \\| \`${V1}\` \\| \`${V2}\` \\|`))
    assert.match(md, /lastShutdown: \*\*unclean\*\*/)
    assert.match(md, new RegExp(`Label \`${UNCLEAN_LABEL}\` added`))
  })
  it('formats down and recovered alerts', () => {
    const rs = run([up(A), fail(), fail('ETIMEDOUT'), up(A)])
    assert.match(formatComment(rs[2].alerts, URL), /### Down: .*\n\n`\/health` failed 2 checks in a row.*`ETIMEDOUT`/)
    assert.match(formatComment(rs[3].alerts, URL), /### Recovered: .*\n\n`\/health` answers again .*\(about 2 min\)/)
  })
  it('says "an unknown time" when a recovery has no valid start of the outage, never "null"', () => {
    const r = step({ ...emptyState(), bootId: A, failures: 2, down: true, firstFailureAt: 'not-a-time' }, up(A))
    const md = formatComment(r.alerts, URL)
    assert.match(md, /answers again at \S+; down since an unknown time\./)
    assert.doesNotMatch(md, /null|about unknown/)
  })
  it('shows a missing value as none, not "null"', () => {
    const [, r] = run([up(A, { version: undefined }), up(B, { version: undefined })])
    assert.match(formatComment(r.alerts, URL), /\| version \| _none_ \| _none_ \|/)
  })
  it('words lastShutdown as a sentence about the previous process', () => {
    const comment = (lastShutdown, previousBootId) => formatComment(run([up(A), up(B, { lastShutdown, previousBootId })])[1].alerts, URL)
    assert.match(comment('unknown', null), /lastShutdown: \*\*unknown\*\*: the previous process left no trustworthy lifecycle marker \(/)
    assert.match(comment('graceful', A), /lastShutdown: \*\*graceful\*\*: the previous process finished a clean SIGTERM\/SIGINT shutdown \(/)
    assert.match(comment('unclean', A), /lastShutdown: \*\*unclean\*\*: the previous process left no record of a clean shutdown: crash.*or a data directory that went read-only under it/)
    assert.match(comment('graceful', C), new RegExp(`is about \`${C}\`, which finished a clean SIGTERM/SIGINT shutdown`))
  })
  it('labels an unclean restart also when it is about a process between two checks (crash loop, read-only volume)', () => {
    const [, r] = run([up(A), up(B, { lastShutdown: 'unclean', previousBootId: C })])
    assert.equal(r.alerts[0].unseen, true)
    assert.deepEqual(labelsFor(r.alerts), [UNCLEAN_LABEL])
    assert.match(formatComment(r.alerts, URL), new RegExp(`Label \`${UNCLEAN_LABEL}\` added`))
  })
})

describe('state block in the issue body', () => {
  it('round-trips the states and keeps the text around it', () => {
    const states = { [URL]: { ...emptyState(), bootId: A } }
    const body = writeStates('Intro text.', states)
    assert.match(body, /^Intro text\.\n\n<!-- uptime-state /)
    assert.deepEqual(readStates(body), states)
    const again = writeStates(body, { [URL]: { ...emptyState(), bootId: B } })
    assert.equal(again.match(/uptime-state/g).length, 1, 'replaced, not appended')
    assert.equal(readStates(again)[URL].bootId, B)
  })
  it('cannot be closed early by a value holding -->', () => {
    const states = { 'https://x/-->': { ...emptyState(), version: '--><b>' } }
    const body = writeStates('', states)
    assert.equal(body.match(/-->/g).length, 1)
    assert.deepEqual(readStates(body), states)
  })
  it('reads a missing or damaged block as no state', () => {
    assert.deepEqual(readStates('no block here'), {})
    assert.deepEqual(readStates('<!-- uptime-state {broken -->'), {})
    assert.deepEqual(readStates(null), {})
  })
})

describe('parseArgs / normalizeUrl', () => {
  it('defaults to production and strips a trailing slash', () => {
    assert.equal(parseArgs([]).url, process.env.UPTIME_URL || URL)
    assert.equal(parseArgs(['--url', 'http://localhost:3000/']).url, 'http://localhost:3000')
    assert.equal(normalizeUrl('https://Example.org/elara/'), 'https://example.org/elara')
  })
  it('reads the state file and dry-run flags', () => {
    assert.deepEqual(parseArgs(['--url', 'http://localhost:3000', '--state-file', 's.json', '--dry-run']), {
      url: 'http://localhost:3000',
      stateFile: 's.json',
      dryRun: true,
    })
  })
  it('refuses a URL that is not plain http(s), and unknown flags', () => {
    assert.throws(() => parseArgs(['--url', 'file:///etc/passwd']), /plain http/)
    assert.throws(() => parseArgs(['--url', 'not a url']), /must be an http/)
    assert.throws(() => normalizeUrl('https://user:pw@example.org'), /plain http/)
    assert.throws(() => normalizeUrl('https://example.org/?q=`@owner`'), /plain http/)
    assert.throws(() => normalizeUrl('https://example.org/#x'), /plain http/)
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/)
  })
})

// #705: errors, failed jobs and slow endpoints from the authenticated metrics endpoint.
const N1 = '019a1c30-0000-7000-8000-000000000004'
const NOTE = '019a1c40-0000-7000-8000-000000000005'
const reqRecord = (seq, over = {}) => ({
  seq,
  at: T1,
  type: 'request',
  reqId: `req-${seq}`,
  route: 'PUT /api/vaults/:id/notes/*',
  status: 500,
  durationMs: 12,
  actor: 'user',
  error: { name: 'Error', code: 'EACCES' },
  ...over,
})
const jobRecord = (seq, job = 'sync') => ({ seq, at: T1, type: 'job', job, subjectId: NOTE, error: { name: 'Error', code: null } })
/** An endpoint response (server/src/monitoring/metrics.ts metricsSnapshot) -> observeMetrics(). */
const metrics = ({ bootId = A, serverErrors = 0, jobFailures = 0, routes = [], errors = [], jobs = {} } = {}) =>
  observeMetrics({
    status: 200,
    body: {
      bootId,
      startedAt: T1,
      totals: { requests: 100, serverErrors, jobFailures },
      jobs: { embedding: { succeeded: 1, failed: 0 }, sync: { succeeded: 0, failed: 0 }, ...jobs },
      routes,
      errors,
      lastSeq: errors.at(-1)?.seq ?? 0,
    },
  })
/** Runs metrics observations through stepMetrics() in order. */
function runMetrics(observations, opts = METRICS_DEFAULTS, state = null) {
  return observations.map((m) => {
    const r = stepMetrics(state, m, opts, T2)
    state = r.state
    return r
  })
}
const kindsOf = (rs) => rs.map((r) => r.alerts.map((a) => a.kind))

describe('observeMetrics', () => {
  it('keeps format-checked records and drops the subject id (comments and the Actions log are public)', () => {
    const m = metrics({ serverErrors: 1, errors: [reqRecord(1), jobRecord(2)] })
    assert.equal(m.ok, true)
    assert.deepEqual(m.errors[0], { seq: 1, at: T1, error: { name: 'Error', code: 'EACCES' }, type: 'request', reqId: 'req-1', route: 'PUT /api/vaults/:id/notes/*', status: 500, durationMs: 12, actor: 'user' })
    assert.deepEqual(m.errors[1], { seq: 2, at: T1, error: { name: 'Error', code: null }, type: 'job', job: 'sync' })
    assert.doesNotMatch(JSON.stringify(m), new RegExp(NOTE))
  })
  it('drops values that could write Markdown, links or mentions into a comment', () => {
    const m = metrics({
      errors: [reqRecord(1, { route: 'GET /x` @owner [x](https://evil)', reqId: '`@owner`', actor: 'admin', error: { name: 'a b', code: '<img>' } }), { seq: 2, type: 'job', job: 'evil' }],
      routes: [{ route: 'GET /ok', count: 3, p95Ms: 10, maxMs: 11 }, { route: '@owner', count: 3, p95Ms: 10, maxMs: 10 }],
    })
    assert.deepEqual(m.errors, [{ seq: 1, at: T1, error: { name: null, code: null }, type: 'request', reqId: null, route: null, status: 500, durationMs: 12, actor: null }])
    assert.deepEqual(m.routes, [{ route: 'GET /ok', count: 3, p95Ms: 10, maxMs: 11 }])
  })
  it('is unavailable on a refusal, a network error or a body that is not the endpoint', () => {
    assert.deepEqual(observeMetrics({ status: 401, body: { error: 'invalid monitoring token' } }), { ok: false, error: 'HTTP 401' })
    assert.deepEqual(observeMetrics({ error: 'ECONNREFUSED' }), { ok: false, error: 'ECONNREFUSED' })
    assert.deepEqual(observeMetrics({ status: 200, body: { status: 'ok' } }), { ok: false, error: 'unexpected response' })
  })
})

describe('stepMetrics', () => {
  it('takes the first read as a baseline, then alerts on new 5xx responses and failed jobs once', () => {
    const rs = runMetrics([
      metrics({ serverErrors: 3, jobFailures: 1, errors: [reqRecord(1), jobRecord(2)] }),
      metrics({ serverErrors: 3, jobFailures: 1, errors: [reqRecord(1), jobRecord(2)] }),
      metrics({ serverErrors: 5, jobFailures: 2, errors: [reqRecord(1), jobRecord(2), reqRecord(3), reqRecord(4), jobRecord(5, 'embedding')], jobs: { embedding: { failed: 1 } } }),
      metrics({ serverErrors: 5, jobFailures: 2, errors: [reqRecord(1), jobRecord(2), reqRecord(3), reqRecord(4), jobRecord(5, 'embedding')] }),
    ])
    assert.deepEqual(kindsOf(rs), [[], [], ['errors', 'jobs'], []])
    const [errors, jobs] = rs[2].alerts
    assert.equal(errors.count, 2)
    assert.deepEqual(errors.recent.map((e) => e.seq), [3, 4], 'only the records since the last check')
    assert.equal(jobs.count, 1)
    assert.deepEqual(jobs.recent.map((e) => e.job), ['embedding'])
    assert.equal(jobs.failedSinceBoot.embedding, 1)
  })
  it('needs ALERT_ERROR_THRESHOLD new 5xx in one interval (a spike), and does not carry a smaller count over', () => {
    const opts = { ...METRICS_DEFAULTS, errorThreshold: 3 }
    const rs = runMetrics([metrics(), metrics({ serverErrors: 2 }), metrics({ serverErrors: 4 }), metrics({ serverErrors: 7 })], opts)
    assert.deepEqual(kindsOf(rs), [[], [], [], ['errors']])
    assert.equal(rs[3].alerts[0].count, 3)
  })
  it('counts everything since a restart as new (cumulative counters reset with the bootId)', () => {
    const rs = runMetrics([metrics({ serverErrors: 9, jobFailures: 4 }), metrics({ bootId: B, serverErrors: 1, jobFailures: 0, errors: [reqRecord(1)] })])
    assert.deepEqual(kindsOf(rs), [[], ['errors']])
    assert.equal(rs[1].alerts[0].count, 1)
    assert.equal(rs[1].alerts[0].restarted, true)
    assert.deepEqual(rs[1].alerts[0].recent.map((e) => e.seq), [1])
  })
  it('alerts a slow route once while it stays slow, again after it recovered, and never below the request minimum', () => {
    const slow = { route: 'GET /api/search', count: 6, p95Ms: 2500, maxMs: 4000 }
    const rs = runMetrics([
      metrics(),
      metrics({ routes: [slow, { route: 'GET /api/rare', count: 2, p95Ms: 9000, maxMs: 9000 }] }),
      metrics({ routes: [slow] }),
      metrics({ routes: [{ ...slow, p95Ms: 100 }] }),
      metrics({ routes: [slow] }),
    ])
    assert.deepEqual(kindsOf(rs), [[], ['slow'], [], [], ['slow']])
    assert.deepEqual(rs[1].alerts[0].routes, [slow])
    assert.equal(rs[1].alerts[0].slowMs, 2000)
  })
  it('alerts once per streak when the endpoint stops answering, and keeps the counts to compare after', () => {
    const refused = observeMetrics({ status: 401 })
    const rs = runMetrics([metrics({ serverErrors: 1 }), refused, refused, metrics({ serverErrors: 1 }), metrics({ serverErrors: 2 })])
    assert.deepEqual(kindsOf(rs), [[], ['metrics-unavailable'], [], [], ['errors']])
    assert.equal(rs[1].alerts[0].error, 'HTTP 401')
  })
  it('re-checks a hand-edited saved state', () => {
    const r = stepMetrics({ bootId: '@owner', serverErrors: 'x', slow: ['`evil`'] }, metrics({ serverErrors: 4 }), METRICS_DEFAULTS, T2)
    assert.deepEqual(r.alerts, [], 'no valid saved bootId: a baseline')
    assert.deepEqual(r.state, { bootId: A, serverErrors: 4, jobFailures: 0, lastSeq: 0, slow: [], unavailable: false })
  })
  it('is kept in the uptime state through restarts and outages', () => {
    const saved = { ...emptyState(), bootId: A, metrics: { bootId: A, serverErrors: 2, jobFailures: 0, lastSeq: 2, slow: [], unavailable: false } }
    assert.deepEqual(step(saved, up(A)).state.metrics, saved.metrics)
    assert.deepEqual(step(saved, up(B)).state.metrics, saved.metrics)
    assert.deepEqual(step(saved, fail()).state.metrics, saved.metrics)
  })
})

describe('metricsOptions', () => {
  it('reads positive integers from ALERT_* and keeps the default otherwise', () => {
    assert.deepEqual(metricsOptions({}), METRICS_DEFAULTS)
    assert.deepEqual(metricsOptions({ ALERT_ERROR_THRESHOLD: '5', ALERT_SLOW_MS: '1500', ALERT_SLOW_MIN_COUNT: '20' }), { errorThreshold: 5, slowMs: 1500, slowMinCount: 20 })
    assert.deepEqual(metricsOptions({ ALERT_ERROR_THRESHOLD: '0', ALERT_SLOW_MS: '-1', ALERT_SLOW_MIN_COUNT: 'many' }), METRICS_DEFAULTS)
  })
})

describe('formatComment: monitoring alerts', () => {
  it('lists server errors with route, status, error class and request id, and says where the message is', () => {
    const [, r] = runMetrics([metrics(), metrics({ serverErrors: 1, errors: [reqRecord(1)] })])
    const md = formatComment(r.alerts, URL)
    assert.match(md, /### Server errors: https:\/\/chapters\.piiix\.org/)
    assert.match(md, /1 new 5xx response since the last check \(alert threshold 1\)/)
    assert.match(md, /\| `2026-10-16T09:00:00.000Z` \| `PUT \/api\/vaults\/:id\/notes\/\*` \| 500 \| `Error EACCES` \| `req-1` \| `user` \| 12 \|/)
    assert.match(md, /never its message or the note it touched/)
  })
  it('lists failed jobs by kind and totals since boot', () => {
    const [, r] = runMetrics([metrics(), metrics({ jobFailures: 1, errors: [jobRecord(1, 'collab-store')], jobs: { 'collab-store': { failed: 1 } } })])
    const md = formatComment(r.alerts, URL)
    assert.match(md, /### Failed background jobs: /)
    assert.match(md, /\| `2026-10-16T09:00:00.000Z` \| `collab-store` \| `Error` \|/)
    assert.match(md, /Failed since the process started: `collab-store` 1\./)
    assert.doesNotMatch(md, new RegExp(NOTE))
  })
  it('formats slow endpoints and an unavailable endpoint', () => {
    const [, slow] = runMetrics([metrics(), metrics({ routes: [{ route: 'GET /api/search', count: 6, p95Ms: 2500, maxMs: 4000 }] })])
    assert.match(formatComment(slow.alerts, URL), /### Slow endpoints: .*\n\n.*2000 ms over at least 5 requests[\s\S]*\| `GET \/api\/search` \| 2500 \| 4000 \| 6 \|/)
    const [, gone] = runMetrics([metrics(), observeMetrics({ status: 401 })])
    assert.match(formatComment(gone.alerts, URL), new RegExp(`### Metrics unavailable: .*\\n\\n\`/health\` is up but \`${METRICS_PATH}\` failed \\(\`HTTP 401\`\\)`))
  })
})

describe('webhook', () => {
  it('takes an http(s) URL or nothing, and never echoes the value', () => {
    assert.equal(webhookTarget(undefined), null)
    assert.equal(webhookTarget(''), null)
    assert.equal(webhookTarget('https://hooks.example/T0/B0/secret'), 'https://hooks.example/T0/B0/secret')
    assert.throws(() => webhookTarget('ftp://hooks.example/secret'), (err) => !err.message.includes('secret'))
    assert.throws(() => webhookTarget('not a url secret'), (err) => !err.message.includes('secret'))
  })
  it('carries the comment as text (Slack) and content (Discord, at most 2000 chars) and the alerts', () => {
    const alerts = [{ kind: 'jobs', at: T2, count: 1, restarted: false, failedSinceBoot: {}, recent: [] }]
    const p = webhookPayload(alerts, URL, 'x'.repeat(2500))
    assert.equal(p.text.length, 2500)
    assert.ok(p.content.length <= 2000)
    assert.equal(p.url, URL)
    assert.deepEqual(p.alerts, alerts)
    assert.equal(webhookPayload(alerts, URL, 'short').content, 'short')
  })
})
