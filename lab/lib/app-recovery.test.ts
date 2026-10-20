// node --test 'lab/lib/*.test.ts' (run by CI `checks`). A fake container
// and clock drive recoverAfterKill through the ways #658 lost the app.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recoverAfterKill, type RecoveryOps } from './app-recovery.ts'

interface StartResult {
  code: number
  /** The start brings the container up (a no-op while docker still has the killed one running). */
  up: boolean
  /** The new process dies this long after the start. */
  dieAfterMs?: number
}

/**
 * A SIGKILLed container: its old process is still `running` until
 * `exitAfterMs`, then `exited`. A started process answers /health `bootMs`
 * after its start.
 */
function fakeContainer(opts: { exitAfterMs: number; bootMs?: number; onStart: (n: number) => StartResult }) {
  let clock = 0
  const c = { status: 'running', old: true, at: 0, dieAt: Number.POSITIVE_INFINITY }
  const fake = { starts: 0, ops: undefined as unknown as RecoveryOps }
  fake.ops = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    status: async () => {
      if (c.old && clock >= opts.exitAfterMs) c.status = 'exited'
      if (c.status === 'running' && clock >= c.dieAt) c.status = 'exited'
      return c.status
    },
    start: async () => {
      fake.starts++
      const r = opts.onStart(fake.starts)
      if (r.up && (await fake.ops.status()) !== 'running')
        Object.assign(c, { status: 'running', old: false, at: clock, dieAt: clock + (r.dieAfterMs ?? Number.POSITIVE_INFINITY) })
      return { code: r.code, stdout: '', stderr: r.code === 0 ? '' : `start ${fake.starts} failed` }
    },
    probe: async () => (await fake.ops.status()) === 'running' && !c.old && clock - c.at >= (opts.bootMs ?? 2_000),
  }
  return fake
}

const fast = { pollMs: 100, retryDelayMs: 500, healthTimeoutMs: 10_000, exitTimeoutMs: 5_000 }

test('waits for the killed container to exit before starting it (a start that early is a no-op)', async () => {
  const f = fakeContainer({ exitAfterMs: 1_500, onStart: () => ({ code: 0, up: true }) })
  const r = await recoverAfterKill(f.ops, fast)
  assert.equal(r.exitedStatus, 'exited')
  assert.ok(r.exitedMs >= 1_500)
  assert.equal(f.starts, 1)
  assert.equal(r.attempts[0]?.outcome, 'healthy')
})

test('retries a failed compose start', async () => {
  const f = fakeContainer({ exitAfterMs: 0, onStart: (n) => (n < 2 ? { code: 1, up: false } : { code: 0, up: true }) })
  const r = await recoverAfterKill(f.ops, fast)
  assert.equal(f.starts, 2)
  assert.deepEqual(
    r.attempts.map((a) => [a.startCode, a.outcome]),
    [
      [1, 'start failed'],
      [0, 'healthy'],
    ],
  )
})

test('starts again when the container exits during boot', async () => {
  const f = fakeContainer({
    exitAfterMs: 0,
    bootMs: 3_000,
    onStart: (n) => ({ code: 0, up: true, dieAfterMs: n === 1 ? 1_000 : undefined }),
  })
  const r = await recoverAfterKill(f.ops, fast)
  assert.deepEqual(
    r.attempts.map((a) => a.outcome),
    ['exited', 'healthy'],
  )
})

test('throws with every attempt when the app never comes back', async () => {
  const f = fakeContainer({ exitAfterMs: 0, onStart: () => ({ code: 1, up: false }) })
  await assert.rejects(recoverAfterKill(f.ops, fast), (err: Error) => {
    assert.match(err.message, /^app did not come back after SIGKILL: attempt 1: start exit 1 \(start 1 failed\), start failed, container exited/)
    assert.match(err.message, /attempt 3: start exit 1 \(start 3 failed\), start failed/)
    return true
  })
  assert.equal(f.starts, 3)
})

test('throws when the started container never answers /health, without a pointless second start', async () => {
  const f = fakeContainer({ exitAfterMs: 0, bootMs: Number.POSITIVE_INFINITY, onStart: () => ({ code: 0, up: true }) })
  await assert.rejects(recoverAfterKill(f.ops, fast), /attempt 1: start exit 0, health timeout, container running/)
  assert.equal(f.starts, 1)
})

test('throws when the killed container never leaves running', async () => {
  const f = fakeContainer({ exitAfterMs: Number.POSITIVE_INFINITY, onStart: () => ({ code: 0, up: true }) })
  await assert.rejects(recoverAfterKill(f.ops, fast), /^Error: app container still running 5000 ms after SIGKILL$/)
  assert.equal(f.starts, 0)
})
