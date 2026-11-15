// #988: Swift is parsed in a child process (extraction-child.ts): under a deadline, respawned after a
// crash, beside the in-process grammars, and a skipped file is never cached. The few real timers
// (an interval counting event-loop turns, a delayed kill) are deliberate: the subject is a real child
// process and a real event loop, which fake timers cannot stand in for.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearParseCache, parseCacheStats, parsed } from '../src/repositories/blob-cache.js'
import { extractStructure } from '../src/repositories/extraction.js'
import { isolatedChildPid, isolatedParseTimeoutMs, isolatedStats, DEFAULT_ISOLATED_PARSE_TIMEOUT_MS } from '../src/repositories/extraction-child.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/languages/${name}`, import.meta.url), 'utf8')
const store = fixture('Store.swift')

/** Declarations that share their names: a parse of this takes seconds (2.5 s for 200 KB), far over a 300 ms deadline. */
function slowSwift(bytes: number): string {
  let source = ''
  while (source.length < bytes) source += store.replace(/\b(Store|load|save)\b/g, (name) => name + Math.floor(source.length / 1000)) + '\n'
  return source
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Swift in a child process (#988)', () => {
  it('extracts Swift symbols and imports through the child', async () => {
    const result = await extractStructure('swift', store, 'Store.swift')
    expect(result.skipped).toBeUndefined()
    expect(result.symbols.map((s) => s.name)).toContain('openStore')
    expect(result.imports.map((i) => i.target)).toEqual(['Foundation', 'Models', 'Storage'])
  })

  it('gives up on a parse past its deadline, keeps the server responsive, and parses the next file in a new child', async () => {
    await extractStructure('swift', store, 'Warm.swift')
    const before = { ...isolatedStats }
    const firstPid = isolatedChildPid()
    vi.stubEnv('ELARA_ISOLATED_PARSE_TIMEOUT_MS', '300')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The server's event loop keeps turning while the child works on the slow file.
    let ticks = 0
    const ticker = setInterval(() => ticks++, 20)
    const started = Date.now()
    const result = await extractStructure('swift', slowSwift(400_000), 'Huge.swift')
    clearInterval(ticker)

    expect(result.symbols).toEqual([])
    expect(result.imports).toEqual([])
    expect(result.skipped).toMatch(/^swift symbols not extracted: no result within 300 ms/)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(ticks).toBeGreaterThan(5)
    expect(isolatedStats.timeouts).toBe(before.timeouts + 1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Huge.swift'))
    // The child was killed, not left running.
    await vi.waitFor(() => expect(() => process.kill(firstPid!, 0)).toThrow(), { timeout: 5_000 })

    vi.unstubAllEnvs()
    const next = await extractStructure('swift', store, 'Store.swift')
    expect(next.skipped).toBeUndefined()
    expect(next.symbols.length).toBeGreaterThan(10)
    expect(isolatedStats.started).toBe(before.started + 1)
    expect(isolatedChildPid()).not.toBe(firstPid)
  })

  it('does not cache a skipped file: the same content is parsed again', async () => {
    clearParseCache()
    await extractStructure('swift', store, 'Warm.swift')
    vi.stubEnv('ELARA_ISOLATED_PARSE_TIMEOUT_MS', '300')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const content = slowSwift(400_000)
    expect((await parsed('swift', content, 'Huge.swift', 'hash-1')).skipped).toBeDefined()
    expect(parseCacheStats.parsed).toBe(0)
    vi.unstubAllEnvs()
    expect((await parsed('swift', store, 'Store.swift', 'hash-2')).skipped).toBeUndefined()
    expect(parseCacheStats.parsed).toBe(1)
  })

  it('starts a new child after the old one is killed from outside, and answers a request that dies with it as skipped', async () => {
    await extractStructure('swift', store, 'Warm.swift')
    const idle = isolatedChildPid()!
    process.kill(idle, 'SIGKILL')
    await vi.waitFor(() => expect(isolatedChildPid()).toBeNull(), { timeout: 5_000 })
    const after = await extractStructure('swift', store, 'Store.swift')
    expect(after.skipped).toBeUndefined()
    expect(after.symbols.length).toBeGreaterThan(10)

    // Killed while parsing: the request is skipped, with the signal as the reason.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const busyPid = isolatedChildPid()!
    const request = extractStructure('swift', slowSwift(400_000), 'Huge.swift')
    setTimeout(() => process.kill(busyPid, 'SIGKILL'), 150)
    const result = await request
    expect(result.skipped).toMatch(/parser process exited \(SIGKILL\)/)
    const again = await extractStructure('swift', store, 'Store.swift')
    expect(again.symbols.length).toBeGreaterThan(10)
  })

  it('serves Swift in the child and Kotlin in the server at the same time', async () => {
    const kotlin = fixture('Store.kt')
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => [extractStructure('swift', `${store}\n// ${i}`, 'Store.swift'), extractStructure('kotlin', `${kotlin}\n// ${i}`, 'Store.kt')]).flat(),
    )
    expect(results.every((r) => r.skipped === undefined && r.symbols.length > 3)).toBe(true)
    expect(results.filter((_, i) => i % 2 === 0).every((r) => r.symbols.some((s) => s.name === 'openStore'))).toBe(true)
  })

  it('reads the deadline from ELARA_ISOLATED_PARSE_TIMEOUT_MS, and falls back to the default for anything else', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(isolatedParseTimeoutMs(undefined)).toBe(DEFAULT_ISOLATED_PARSE_TIMEOUT_MS)
    expect(isolatedParseTimeoutMs('2500')).toBe(2500)
    for (const bad of ['0', '-5', 'ten', '1.5', ' ']) expect(isolatedParseTimeoutMs(bad)).toBe(DEFAULT_ISOLATED_PARSE_TIMEOUT_MS)
  })
})
