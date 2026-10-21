// Bringing the app back after a SIGKILL (#658). Pure: every effect is
// injected, so lab/lib/app-recovery.test.ts drives it with fakes and
// `app.crash()` (docker.ts) with docker. Plain TypeScript, no Bun globals.
//
// Why each step: a `compose start` that runs while the killed container is
// still `running` is a no-op, the container then exits and stays down (a
// container stopped by `docker kill` is not restarted by `unless-stopped`);
// a start can also fail outright. Lab run 38957397867 lost the instance that
// way and every later test crashed on it.

export interface RecoveryOps {
  /** Container status (`running`, `exited`, ...); null when it cannot be read (mid-transition). */
  status(): Promise<string | null>
  /** `compose start app`. */
  start(): Promise<{ code: number; stdout: string; stderr: string }>
  /** One GET /health; true on 200. */
  probe(): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
}

export interface RecoveryOptions {
  /** Max wait for the killed container to leave `running`. */
  exitTimeoutMs: number
  /** `compose start` attempts. */
  attempts: number
  /** Max wait for /health after a start that left the container running. */
  healthTimeoutMs: number
  pollMs: number
  /** Pause before the next start after a failed one. */
  retryDelayMs: number
}

export const DEFAULT_RECOVERY: RecoveryOptions = {
  exitTimeoutMs: 30_000,
  attempts: 3,
  healthTimeoutMs: 300_000,
  pollMs: 1_000,
  retryDelayMs: 3_000,
}

export interface StartAttempt {
  attempt: number
  startCode: number
  startOutput: string
  /** Container status when this attempt ended. */
  status: string | null
  outcome: 'healthy' | 'start failed' | 'exited' | 'health timeout'
  ms: number
}

export interface Recovery {
  /** ms from the call until the killed container was seen leaving `running`. */
  exitedMs: number
  /** The status seen then (`exited`, `dead`, ...). */
  exitedStatus: string
  attempts: StartAttempt[]
  /** ms from the call until /health answered. */
  healthyMs: number
}

/**
 * After the app container was SIGKILLed: waits until the old process is gone
 * (status leaves `running`), then starts it, retrying a failed start or a
 * container that exits again, and waits for /health. Throws an error naming
 * every attempt when the app does not come back; never returns with the app
 * down.
 */
export async function recoverAfterKill(ops: RecoveryOps, options: Partial<RecoveryOptions> = {}): Promise<Recovery> {
  const o = { ...DEFAULT_RECOVERY, ...options }
  const t0 = ops.now()
  const elapsed = () => ops.now() - t0

  let exitedStatus: string
  for (;;) {
    const s = await ops.status()
    if (s !== null && s !== 'running') {
      exitedStatus = s
      break
    }
    if (elapsed() > o.exitTimeoutMs) throw new Error(`app container still ${s ?? 'unreadable'} ${o.exitTimeoutMs} ms after SIGKILL`)
    await ops.sleep(o.pollMs)
  }
  const exitedMs = elapsed()

  const attempts: StartAttempt[] = []
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    const a0 = ops.now()
    const r = await ops.start()
    let status = await ops.status()
    let outcome: StartAttempt['outcome'] = 'start failed'
    // A failed start with the container running anyway (docker brought it
    // back) still gets the health wait.
    if (r.code === 0 || status === 'running') {
      for (;;) {
        if (await ops.probe()) {
          outcome = 'healthy'
          break
        }
        status = await ops.status()
        if (status !== null && status !== 'running' && status !== 'restarting') {
          outcome = 'exited'
          break
        }
        if (ops.now() - a0 > o.healthTimeoutMs) {
          outcome = 'health timeout'
          break
        }
        await ops.sleep(o.pollMs)
      }
    }
    attempts.push({
      attempt,
      startCode: r.code,
      startOutput: `${r.stdout} ${r.stderr}`.replace(/\s+/g, ' ').trim().slice(0, 300),
      status,
      outcome,
      ms: ops.now() - a0,
    })
    if (outcome === 'healthy') return { exitedMs, exitedStatus, attempts, healthyMs: elapsed() }
    // A container that is up but never healthy: another start would be a no-op.
    if (outcome === 'health timeout') break
    if (attempt < o.attempts) await ops.sleep(o.retryDelayMs)
  }
  const tried = attempts
    .map(
      (a) =>
        `attempt ${a.attempt}: start exit ${a.startCode}${a.startOutput ? ` (${a.startOutput})` : ''}, ` +
        `${a.outcome}, container ${a.status ?? 'unreadable'} after ${Math.round(a.ms)} ms`,
    )
    .join('; ')
  throw new Error(`app did not come back after SIGKILL: ${tried}`)
}
