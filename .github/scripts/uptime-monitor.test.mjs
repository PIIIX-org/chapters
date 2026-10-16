// Unit tests for the pure parts of uptime-monitor.mjs (#583).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DOWN_AFTER,
  UNCLEAN_LABEL,
  emptyState,
  formatComment,
  labelsFor,
  observe,
  parseArgs,
  readStates,
  step,
  writeStates,
} from './uptime-monitor.mjs'

const URL = 'https://chapters.piiix.org'
const A = '019a1c00-0000-7000-8000-000000000001'
const B = '019a1c10-0000-7000-8000-000000000002'
let minute = 0
const at = () => new Date(Date.UTC(2026, 9, 16, 10, minute++)).toISOString()
const up = (bootId, over = {}) =>
  observe({
    at: at(),
    status: 200,
    body: { status: 'ok', bootId, startedAt: '2026-10-16T09:00:00.000Z', version: 'abc123', lastShutdown: 'graceful', ...over },
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
    const o = up(A, { lastShutdown: 'unclean' })
    assert.equal(o.ok, true)
    assert.deepEqual(o.health, { bootId: A, startedAt: '2026-10-16T09:00:00.000Z', version: 'abc123', lastShutdown: 'unclean' })
  })
  it('treats the old payload ({status: ok} only) as up with unknown identity', () => {
    const o = observe({ at: at(), status: 200, body: { status: 'ok' } })
    assert.equal(o.ok, true)
    assert.deepEqual(o.health, { bootId: null, startedAt: null, version: null, lastShutdown: null })
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
    const rs = run([up(A, { startedAt: 't1', version: 'v1' }), up(B, { startedAt: 't2', version: 'v2', lastShutdown: 'graceful' }), up(B)])
    assert.equal(rs[1].alerts.length, 1)
    const [alert] = rs[1].alerts
    assert.equal(alert.kind, 'restart')
    assert.deepEqual(alert.previous, { bootId: A, startedAt: 't1', version: 'v1' })
    assert.deepEqual(alert.current, { bootId: B, startedAt: 't2', version: 'v2' })
    assert.equal(alert.lastShutdown, 'graceful')
    assert.deepEqual(labelsFor(rs[1].alerts), [])
    assert.deepEqual(rs[2].alerts, [], 'the same restart is not reported twice')
  })
  it('labels an unclean restart', () => {
    const rs = run([up(A), up(B, { lastShutdown: 'unclean' })])
    assert.equal(rs[1].alerts[0].lastShutdown, 'unclean')
    assert.deepEqual(labelsFor(rs[1].alerts), [UNCLEAN_LABEL])
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
    const rs = run([up(A), fail(), fail(), up(B, { lastShutdown: 'unclean' })])
    assert.deepEqual(rs[3].alerts.map((a) => a.kind), ['recovered', 'restart'])
    assert.deepEqual(labelsFor(rs[3].alerts), [UNCLEAN_LABEL])
  })
  it('keeps the last seen identity while down, so the restart is still compared', () => {
    const rs = run([up(A), fail(), fail(), fail()])
    assert.equal(rs[3].state.bootId, A)
  })
})

describe('formatComment', () => {
  it('names the URL, both startedAt and versions, and explains lastShutdown', () => {
    const [, r] = run([up(A, { startedAt: 't1', version: 'v1' }), up(B, { startedAt: 't2', version: 'v2', lastShutdown: 'unclean' })])
    const md = formatComment(r.alerts, URL)
    assert.match(md, /### Restart: https:\/\/chapters\.piiix\.org/)
    assert.match(md, /\| startedAt \| `t1` \| `t2` \|/)
    assert.match(md, /\| version \| `v1` \| `v2` \|/)
    assert.match(md, /lastShutdown: \*\*unclean\*\*/)
    assert.match(md, new RegExp(`Label \`${UNCLEAN_LABEL}\` added`))
  })
  it('formats down and recovered alerts', () => {
    const rs = run([up(A), fail(), fail('ETIMEDOUT'), up(A)])
    assert.match(formatComment(rs[2].alerts, URL), /### Down: .*\n\n`\/health` failed 2 checks in a row.*`ETIMEDOUT`/)
    assert.match(formatComment(rs[3].alerts, URL), /### Recovered: .*\n\n`\/health` answers again .*\(about 2 min\)/)
  })
  it('shows a missing value as none, not "null"', () => {
    const [, r] = run([up(A, { version: undefined }), up(B, { version: undefined })])
    assert.match(formatComment(r.alerts, URL), /\| version \| _none_ \| _none_ \|/)
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

describe('parseArgs', () => {
  it('defaults to production and strips a trailing slash', () => {
    assert.equal(parseArgs([]).url, process.env.UPTIME_URL || URL)
    assert.equal(parseArgs(['--url', 'http://localhost:3000/']).url, 'http://localhost:3000')
  })
  it('reads the state file and dry-run flags', () => {
    assert.deepEqual(parseArgs(['--url', 'http://localhost:3000', '--state-file', 's.json', '--dry-run']), {
      url: 'http://localhost:3000',
      stateFile: 's.json',
      dryRun: true,
    })
  })
  it('refuses a URL that is not http(s) and unknown flags', () => {
    assert.throws(() => parseArgs(['--url', 'file:///etc/passwd']), /must be an http/)
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/)
  })
})
