import { describe, it, expect, beforeEach } from 'vitest'
import { checkRateLimit, resetRateLimits } from '../src/mcp/rate-limit.js'

describe('mcp rate limiting', () => {
  beforeEach(() => {
    resetRateLimits()
  })

  it('permits calls up to the ceiling and blocks call #121', () => {
    const connId = 'test-conn-1'
    for (let i = 1; i <= 120; i++) {
      expect(checkRateLimit(connId)).toBe(true)
    }
    // 121st call must be blocked
    expect(checkRateLimit(connId)).toBe(false)
  })

  it('maintains independent rate limits across distinct connections', () => {
    const connA = 'conn-a'
    const connB = 'conn-b'

    for (let i = 1; i <= 120; i++) {
      checkRateLimit(connA)
    }
    expect(checkRateLimit(connA)).toBe(false)

    // connB should still be unthrottled
    expect(checkRateLimit(connB)).toBe(true)
  })

  it('clears state upon resetRateLimits', () => {
    const conn = 'conn-reset'
    for (let i = 1; i <= 120; i++) {
      checkRateLimit(conn)
    }
    expect(checkRateLimit(conn)).toBe(false)

    resetRateLimits()
    expect(checkRateLimit(conn)).toBe(true)
  })
})
