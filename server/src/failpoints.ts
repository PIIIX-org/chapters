/**
 * Lab failpoints (ADR-003 §11, Q11): named points on the store's write and
 * projection paths where the integration lab SIGKILLs the server to prove
 * that every crash boundary reconciles. Inert unless `ELARA_FAILPOINTS`
 * names the point (`ELARA_FAILPOINTS=edit.before-commit,projector.after-tmp-before-rename`):
 * then the process kills itself there with SIGKILL, as a power loss or the
 * OOM killer would, so nothing after the point runs (no `finally`, no
 * graceful shutdown).
 *
 * Server tests cannot kill the test runner; they install a handler with
 * `setFailpointHandler` that throws at the chosen point instead, then run
 * the same reconciliation against the database the "crashed" call left.
 */

/** Every failpoint the server checks. Kept in one list so the lab and the docs name the same points. */
export const FAILPOINTS = [
  'edit.before-commit',
  'edit.after-commit-before-ack',
  'edit.after-commit-before-live-apply',
  'create.after-commit-before-file',
  'projector.after-tmp-before-rename',
  'projector.after-rename-before-mark',
  'rename.after-commit-before-refactor',
  'purge.after-commit-before-remove',
  'fold.before-commit',
  'migration.mid-batch',
] as const

export type Failpoint = (typeof FAILPOINTS)[number]

const armed = new Set((process.env.ELARA_FAILPOINTS ?? '').split(',').map((name) => name.trim()).filter(Boolean))

let handler: ((name: Failpoint) => void) | null = null

/** Thrown by a test handler at its failpoint. */
export class FailpointError extends Error {
  constructor(readonly failpoint: Failpoint) {
    super(`failpoint ${failpoint}`)
  }
}

/** Marks a crash boundary: SIGKILLs the process when `ELARA_FAILPOINTS` names it, or runs the test handler. */
export function failpoint(name: Failpoint): void {
  if (handler) {
    handler(name)
    return
  }
  if (armed.has(name)) {
    console.error(`[failpoint] ${name}: SIGKILL`)
    process.kill(process.pid, 'SIGKILL')
  }
}

/** Tests only: `fn` runs at every failpoint (throw to simulate the crash there); null removes it. */
export function setFailpointHandler(fn: ((name: Failpoint) => void) | null): void {
  handler = fn
}
