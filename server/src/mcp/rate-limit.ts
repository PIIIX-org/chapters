// ponytail: in-memory per-process bucket; DB/redis if multi-process
const LIMIT = Number(process.env.MCP_RATE_LIMIT ?? 120)
const WINDOW_MS = 60_000

const buckets = new Map<string, { count: number; windowStart: number }>()

/** Per-connection throttle (audit: structural requirement, not deferred). */
export function checkRateLimit(connectionId: string): boolean {
  const now = Date.now()
  const bucket = buckets.get(connectionId)
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(connectionId, { count: 1, windowStart: now })
    return true
  }
  bucket.count += 1
  return bucket.count <= LIMIT
}

export function resetRateLimits(): void {
  buckets.clear()
}
