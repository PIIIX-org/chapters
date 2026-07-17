// ponytail: in-memory per-process lockout; move to DB/redis if multi-process
const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 10

const failures = new Map<string, { count: number; windowStart: number }>()

export function isLocked(key: string): boolean {
  const entry = failures.get(key)
  if (!entry) return false
  if (Date.now() - entry.windowStart > WINDOW_MS) {
    failures.delete(key)
    return false
  }
  return entry.count >= MAX_FAILURES
}

export function recordFailure(key: string): void {
  const now = Date.now()
  const entry = failures.get(key)
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    failures.set(key, { count: 1, windowStart: now })
  } else {
    entry.count += 1
  }
}

export function clearFailures(key: string): void {
  failures.delete(key)
}

export function resetLockouts(): void {
  failures.clear()
}
