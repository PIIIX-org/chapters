// #988: Swift is parsed in a child process (extraction-child.ts). The child owns the parse deadline, a process that
// cannot answer is an error and not an empty result, answers are bounded, and the lanes are bounded. The few real
// timers (an interval counting event-loop turns, a delayed kill, a blocked loop) are deliberate: the subject is a real
// child process and a real event loop, which fake timers cannot stand in for.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearParseCache, parseCacheStats, parsed } from '../src/repositories/blob-cache.js'
import { extractStructure } from '../src/repositories/extraction.js'
import {
  DEFAULT_ISOLATED_PARSE_TIMEOUT_MS,
  IsolatedUnavailable,
  MAX_ISOLATED_PARSE_TIMEOUT_MS,
  MAX_NAME_CHARS,
  MAX_OVERLAY_PER_CALLER,
  MAX_OVERLAY_QUEUE,
  MAX_REPLY_BYTES,
  encodeResult,
  isolatedChildPid,
  isolatedParseTimeoutMs,
  isolatedStats,
  readReply,
  resetIsolatedChild,
  watchdogMs,
} from '../src/repositories/extraction-child.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/languages/${name}`, import.meta.url), 'utf8')
const store = fixture('Store.swift')
const realExecPath = process.execPath

/** A source of about `bytes` characters with distinct names, as real code has: a new child parses 400 KB in 0.25 s and 1 MB in 0.8 s. */
function largeSwift(bytes: number): string {
  let source = ''
  for (let k = 0; source.length < bytes; k++) source += store.replace(/\b(Store|load|save|Entry|Event|Backend|DiskStore|helper|openStore)\b/g, (name) => name + k) + '\n'
  return source
}

const quietly = () => vi.spyOn(console, 'warn').mockImplementation(() => {})
const gone = (pid: number) => vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 })

beforeEach(() => resetIsolatedChild())
afterEach(() => {
  Object.defineProperty(process, 'execPath', { value: realExecPath })
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetIsolatedChild()
})

describe('Swift in a child process (#988)', () => {
  it('extracts Swift symbols and imports through the child', async () => {
    const result = await extractStructure('swift', store, 'Store.swift')
    expect(result.skipped).toBeUndefined()
    expect(result.symbols.map((s) => s.name)).toContain('openStore')
    expect(result.imports.map((i) => i.target)).toEqual(['Foundation', 'Models', 'Storage'])
  })

  it('serves Swift in the child and Kotlin in the server at the same time', async () => {
    const kotlin = fixture('Store.kt')
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => [extractStructure('swift', `${store}\n// ${i}`, 'Store.swift'), extractStructure('kotlin', `${kotlin}\n// ${i}`, 'Store.kt')]).flat(),
    )
    expect(results.every((r) => r.skipped === undefined && r.symbols.length > 3)).toBe(true)
    expect(results.filter((_, i) => i % 2 === 0).every((r) => r.symbols.some((s) => s.name === 'openStore'))).toBe(true)
  })

  describe('the deadline', () => {
    it('is the child’s: a parse past it is skipped with a reason, the server keeps turning, and nothing counts as a failure', async () => {
      const before = { ...isolatedStats }
      vi.stubEnv('ELARA_ISOLATED_PARSE_TIMEOUT_MS', '1')
      const warn = quietly()

      let ticks = 0
      const ticker = setInterval(() => ticks++, 5)
      const started = Date.now()
      const result = await extractStructure('swift', largeSwift(300_000), 'Huge.swift')
      clearInterval(ticker)

      expect(result.symbols).toEqual([])
      expect(result.skipped).toMatch(/^swift symbols not extracted: the parse took longer than 1 ms/)
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(ticks).toBeGreaterThan(2)
      expect(isolatedStats.skipped).toBe(before.skipped + 1)
      expect(isolatedStats.failures).toBe(before.failures)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Huge.swift'))
      vi.unstubAllEnvs()
      expect((await extractStructure('swift', store, 'Store.swift')).symbols.length).toBeGreaterThan(10)
    })

    it('is not missed by a server event loop that stalls past the watchdog: the child’s answer is used', async () => {
      await extractStructure('swift', store, 'Warm.swift')
      const pid = isolatedChildPid()
      vi.stubEnv('ELARA_ISOLATED_PARSE_TIMEOUT_MS', '100')
      const stall = watchdogMs(100) + 400
      const request = extractStructure('swift', store, 'Store.swift')
      await new Promise((resolve) => setImmediate(resolve))
      // The request is sent; the child answers within milliseconds while the server cannot look.
      const until = Date.now() + stall
      while (Date.now() < until) {
        // blocked on purpose
      }
      const result = await request
      expect(result.skipped).toBeUndefined()
      expect(result.symbols.length).toBeGreaterThan(10)
      expect(isolatedChildPid()).toBe(pid)
    })

    it('reads ELARA_ISOLATED_PARSE_TIMEOUT_MS, and falls back to the default for anything else', () => {
      quietly()
      expect(isolatedParseTimeoutMs(undefined)).toBe(DEFAULT_ISOLATED_PARSE_TIMEOUT_MS)
      expect(isolatedParseTimeoutMs('2500')).toBe(2500)
      for (const bad of ['0', '-5', 'ten', '1.5', ' ']) expect(isolatedParseTimeoutMs(bad)).toBe(DEFAULT_ISOLATED_PARSE_TIMEOUT_MS)
      // Node's timers stop at 2^31 - 1 ms and the server's run at up to twice the deadline: a huge setting is cut to the maximum.
      for (const huge of ['2147483647', '99999999999', String(MAX_ISOLATED_PARSE_TIMEOUT_MS + 1)]) expect(isolatedParseTimeoutMs(huge)).toBe(MAX_ISOLATED_PARSE_TIMEOUT_MS)
      expect(watchdogMs(MAX_ISOLATED_PARSE_TIMEOUT_MS)).toBeLessThan(2 ** 31 - 1)
      expect(MAX_ISOLATED_PARSE_TIMEOUT_MS * 2).toBeLessThan(2 ** 31 - 1)
    })

    it('does not cache a skipped file: the same content is parsed again', async () => {
      clearParseCache()
      vi.stubEnv('ELARA_ISOLATED_PARSE_TIMEOUT_MS', '1')
      quietly()
      expect((await parsed('swift', largeSwift(300_000), 'Huge.swift', 'hash-1')).skipped).toBeDefined()
      expect(parseCacheStats.parsed).toBe(0)
      vi.unstubAllEnvs()
      expect((await parsed('swift', store, 'Store.swift', 'hash-2')).skipped).toBeUndefined()
      expect(parseCacheStats.parsed).toBe(1)
    })

    it('gives a large file a child that has parsed nothing: a second 1 MB file is parsed as fast as the first', async () => {
      await extractStructure('swift', store, 'Warm.swift')
      const warm = isolatedChildPid()
      const times: number[] = []
      for (const bytes of [1_000_000, 1_000_001]) {
        const started = Date.now()
        const result = await extractStructure('swift', largeSwift(bytes), `Big${bytes}.swift`)
        times.push(Date.now() - started)
        expect(result.skipped).toBeUndefined()
        expect(result.symbols.length).toBeGreaterThan(16_000)
        // The child that parsed it is gone.
        expect(isolatedChildPid()).toBeNull()
      }
      expect(warm).not.toBeNull()
      // Parsed in a new process each time (about 1 s); in a used one the second took over a minute.
      expect(Math.max(...times)).toBeLessThan(15_000)
    })
  })

  describe('a parser process that cannot answer is an error, not an empty result', () => {
    const breakStart = () => Object.defineProperty(process, 'execPath', { value: '/usr/bin/false' })
    const fixStart = () => Object.defineProperty(process, 'execPath', { value: realExecPath })

    it('rejects while the child cannot start, and parses once it can', async () => {
      quietly()
      breakStart()
      await expect(extractStructure('swift', store, 'Store.swift')).rejects.toMatchObject({ name: 'IsolatedUnavailable', kind: 'failed' })
      fixStart()
      const result = await extractStructure('swift', store, 'Store.swift')
      expect(result.skipped).toBeUndefined()
      expect(result.symbols.length).toBeGreaterThan(10)
    })

    it('rejects, and does not skip, a request whose child is killed while it parses', async () => {
      quietly()
      // A large file starts a child of its own, parsing for about a second.
      const request = extractStructure('swift', largeSwift(1_000_000), 'Huge.swift')
      const busy = isolatedChildPid()!
      const assertion = expect(request).rejects.toThrow(/exited \(SIGKILL\) before it answered/)
      setTimeout(() => process.kill(busy, 'SIGKILL'), 150)
      await assertion
      expect((await extractStructure('swift', store, 'Store.swift')).symbols.length).toBeGreaterThan(10)
    })

    it('replaces a child killed from outside while idle', async () => {
      await extractStructure('swift', store, 'Warm.swift')
      process.kill(isolatedChildPid()!, 'SIGKILL')
      await vi.waitFor(() => expect(isolatedChildPid()).toBeNull(), { timeout: 5_000 })
      expect((await extractStructure('swift', store, 'Store.swift')).symbols.length).toBeGreaterThan(10)
    })

    it('calls a child that stays silent stuck after the watchdog, kills it, and starts another for the next file', async () => {
      quietly()
      vi.stubEnv('ELARA_ISOLATED_PARSE_TIMEOUT_MS', '200')
      await extractStructure('swift', store, 'Warm.swift')
      const frozen = isolatedChildPid()!
      process.kill(frozen, 'SIGSTOP')
      await expect(extractStructure('swift', store, 'Store.swift')).rejects.toThrow(/gave no answer within 2300 ms/)
      await gone(frozen)
      vi.unstubAllEnvs()
      expect((await extractStructure('swift', store, 'Store.swift')).symbols.length).toBeGreaterThan(10)
    })

    it('starts a child that keeps failing again only after a growing delay', async () => {
      quietly()
      breakStart()
      for (let i = 0; i < 3; i++) await expect(extractStructure('swift', store, 'Store.swift')).rejects.toBeInstanceOf(IsolatedUnavailable)
      const started = isolatedStats.started
      fixStart()
      await expect(extractStructure('swift', store, 'Store.swift')).rejects.toThrow(/failed 3 times in a row; it is started again in/)
      expect(isolatedStats.started).toBe(started)
      // The delay passes (the clock only: the child and its timers run in real time).
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 60_000)
      expect((await extractStructure('swift', store, 'Store.swift')).symbols.length).toBeGreaterThan(10)
    })
  })

  describe('the answer is bounded', () => {
    /** A 70 KB source: one class with an 8,000-character name and 5,000 methods, so 5,000 symbols carry that parent. */
    const hostile = () => `class ${'A'.repeat(8_000)} {\n${Array.from({ length: 5_000 }, (_, i) => `  func m${i}() {}`).join('\n')}\n}\n`

    it('leaves out symbols whose names are over the limit, says so, and sends a small answer', async () => {
      const warn = quietly()
      const source = hostile()
      expect(source.length).toBeLessThan(200_000)
      const result = await extractStructure('swift', `${source}\nfunc ok() {}\n`, 'Hostile.swift')
      expect(result.skipped).toBeUndefined()
      expect(result.symbols.map((s) => s.name)).toEqual(['ok'])
      expect(result.truncated).toMatch(/5001 symbols or imports left out/)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Hostile.swift'))
    })

    it('cuts what the child encodes to the limits', () => {
      const symbol = (name: string, parent?: string) => ({ name, kind: 'method' as const, startLine: 1, endLine: 1, exported: false, ...(parent ? { parent } : {}) })
      const long = 'x'.repeat(MAX_NAME_CHARS + 1)
      const encoded = JSON.parse(encodeResult({ imports: [], sites: [], symbols: [symbol('a'), symbol(long), symbol('b', long), symbol('c', 'P')] }))
      expect(encoded.symbols.map((s: { name: string }) => s.name)).toEqual(['a', 'c'])
      expect(encoded.truncated).toMatch(/2 symbols or imports left out/)
      // Many symbols of the longest allowed names: halved until the JSON fits.
      const many = Array.from({ length: 30_000 }, (_, i) => symbol(`${'n'.repeat(MAX_NAME_CHARS - 10)}${i}`, 'p'.repeat(MAX_NAME_CHARS)))
      const payload = encodeResult({ imports: [], sites: [], symbols: many })
      expect(payload.length).toBeLessThanOrEqual(MAX_REPLY_BYTES)
      expect(JSON.parse(payload).symbols.length).toBeLessThan(30_000)
    })

    it('reads only an answer of the right size and shape', () => {
      const good = JSON.stringify({ imports: [{ target: 'Foundation', line: 1 }], sites: [], symbols: [{ name: 'f', kind: 'function', startLine: 1, endLine: 2, exported: false }] })
      expect(readReply(good)).toMatchObject({ result: { symbols: [{ name: 'f' }] } })
      expect(readReply('x'.repeat(MAX_REPLY_BYTES + 1))).toEqual({ rejected: `the answer is over ${MAX_REPLY_BYTES} bytes` })
      expect(readReply(42)).toEqual({ rejected: 'the answer is not text' })
      expect(readReply('{')).toEqual({ rejected: 'the answer is not JSON' })
      expect(readReply('{"symbols":[]}')).toEqual({ rejected: 'the answer is not a result' })
      const long = JSON.stringify({ imports: [], sites: [], symbols: [{ name: 'x'.repeat(MAX_NAME_CHARS + 1), kind: 'function', startLine: 1, endLine: 1, exported: false }] })
      expect(readReply(long)).toEqual({ rejected: 'a symbol in the answer is malformed' })
      const line0 = JSON.stringify({ imports: [{ target: 'A', line: 0 }], sites: [], symbols: [] })
      expect(readReply(line0)).toEqual({ rejected: 'an import in the answer is malformed' })
    })
  })

  describe('the lanes are bounded', () => {
    /** Occupies the child for about a second (a large file, in a new process), so what follows has to queue. */
    function occupy(caller: string) {
      return { running: extractStructure('swift', largeSwift(1_000_000), 'Slow.swift', { lane: 'overlay', caller }) }
    }

    it('answers busy at once to a caller with its share in flight, and to anyone when the overlay lane is full', async () => {
      quietly()
      const { running } = occupy('a')
      const overlay = (caller: string) => extractStructure('swift', store, 'Store.swift', { lane: 'overlay', caller })
      const waiting: Array<Promise<unknown>> = [running]
      // `a` has the running one and one waiting: its share (MAX_OVERLAY_PER_CALLER) is used.
      expect(MAX_OVERLAY_PER_CALLER).toBe(2)
      waiting.push(overlay('a'))
      await expect(overlay('a')).rejects.toMatchObject({ kind: 'busy', reason: expect.stringContaining('already has 2 Swift overlay requests') })
      // Others fill the lane.
      for (const caller of ['b', 'c', 'd']) waiting.push(overlay(caller))
      expect(MAX_OVERLAY_QUEUE).toBe(4)
      await expect(overlay('e')).rejects.toMatchObject({ kind: 'busy', reason: expect.stringContaining('4 overlay requests are already waiting') })
      const results = await Promise.all(waiting)
      expect(results).toHaveLength(5)
      // Waiting did not lose them: the queued ones were answered after the slow one.
      expect(isolatedStats.busy).toBeGreaterThanOrEqual(2)
    })

    it('serves the index lane before waiting overlay requests', async () => {
      quietly()
      const { running } = occupy('a')
      const order: string[] = []
      const track = (name: string, p: Promise<unknown>) => p.then(() => order.push(name))
      const all = [
        track('slow', running),
        track('overlay', extractStructure('swift', store, 'Store.swift', { lane: 'overlay', caller: 'b' })),
        track('index', extractStructure('swift', store, 'Store.swift')),
      ]
      await Promise.all(all)
      expect(order).toEqual(['slow', 'index', 'overlay'])
    })
  })

  describe('the child retires itself', () => {
    it('after an answer that leaves it over its RSS limit: the next file gets a new child', async () => {
      vi.stubEnv('ELARA_ISOLATED_CHILD_RSS_MB', '1')
      const first = await extractStructure('swift', store, 'Store.swift')
      expect(first.symbols.length).toBeGreaterThan(10)
      // The child told the server it is leaving, so the server holds no handle on it.
      expect(isolatedChildPid()).toBeNull()
      const started = isolatedStats.started
      expect((await extractStructure('swift', store, 'Store.swift')).symbols.length).toBeGreaterThan(10)
      expect(isolatedStats.started).toBe(started + 1)
    })

    it('after a number of files', async () => {
      vi.stubEnv('ELARA_ISOLATED_CHILD_MAX_PARSES', '2')
      const started = isolatedStats.started
      const pids: Array<number | null> = []
      for (let i = 0; i < 3; i++) {
        expect((await extractStructure('swift', `${store}\n// ${i}`, 'Store.swift')).symbols.length).toBeGreaterThan(10)
        pids.push(isolatedChildPid())
      }
      // Files 1 and 2 share a child, which retires after the second; the third needs another.
      expect(isolatedStats.started).toBe(started + 2)
      expect(pids[1]).toBeNull()
    })
  })
})
