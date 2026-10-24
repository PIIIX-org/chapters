// ponytail: in-memory per-process bucket; DB/redis if multi-process
const LIMIT = Number(process.env.MCP_RATE_LIMIT ?? 120)
const WINDOW_MS = 60_000

const buckets = new Map<string, { count: number; windowStart: number }>()

/**
 * Per-connection throttle (audit: structural requirement, not deferred): at
 * most LIMIT requests in a window of WINDOW_MS from the window's first
 * request. A refused request learns how long until the window ends
 * (`retryAfterMs`, 1..WINDOW_MS, #440): a request sent then opens a new one.
 */
export function checkRateLimit(connectionId: string): { ok: true } | { ok: false; retryAfterMs: number } {
  const now = Date.now()
  const bucket = buckets.get(connectionId)
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(connectionId, { count: 1, windowStart: now })
    return { ok: true }
  }
  bucket.count += 1
  return bucket.count <= LIMIT ? { ok: true } : { ok: false, retryAfterMs: bucket.windowStart + WINDOW_MS - now }
}

export function resetRateLimits(): void {
  buckets.clear()
}
