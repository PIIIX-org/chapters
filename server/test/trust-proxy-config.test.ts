import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTrustProxy } from '../src/config.js'

// ELARA_TRUST_PROXY (#911): off unless it names the proxies (or a hop count),
// and never "trust everyone", which would let any client choose its own
// address for the rate limits, the login lockout and the security events.

describe('readTrustProxy', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is off when unset, empty or false', () => {
    for (const raw of [undefined, '', '  ', 'false']) expect(readTrustProxy(raw)).toBe(false)
  })

  it('reads a list of addresses, CIDRs and range names', () => {
    expect(readTrustProxy('127.0.0.1')).toEqual(['127.0.0.1'])
    expect(readTrustProxy('172.16.0.0/12, 10.0.0.7,::1, fd00::/8,loopback')).toEqual([
      '172.16.0.0/12',
      '10.0.0.7',
      '::1',
      'fd00::/8',
      'loopback',
    ])
  })

  it('refuses to trust every peer, a hop count, or anything it cannot read, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A hop count cannot tell the proxy from a client that reached the port directly (Fastify trusts none).
    const refused = ['true', '*', '0.0.0.0/0', '::/0', '0', '1', '2', '0.0.0.0/33', 'proxy.internal', '10.0.0.7, nonsense', '10.0.0.0/8/1', '-1']
    for (const raw of refused) expect(readTrustProxy(raw)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(refused.length)
  })
})
