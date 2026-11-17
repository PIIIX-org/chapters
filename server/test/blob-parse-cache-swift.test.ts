// #988 with #1148: Swift results come from the parser child process (extraction-child.ts) over IPC as JSON, so
// their strings are already owned by this process; `parsed()` still estimates and detaches them like any other
// result. A result cut to the child's 30,000-item limit is over the cache's 4 MiB per-entry cap: it is returned,
// with its `truncated` note, and not kept. Real extraction through the real child, no mock.
import { afterEach, describe, expect, it } from 'vitest'
import { PARSE_CACHE_ENTRY_BYTES, clearParseCache, estimateExtractionBytes, parseCacheStats, parsed } from '../src/repositories/blob-cache.js'
import { MAX_RESULT_ITEMS, resetIsolatedChild } from '../src/repositories/extraction-child.js'

afterEach(() => {
  resetIsolatedChild()
  clearParseCache()
})

/** `count` top-level functions with 11-character names: about 14 bytes of source each. */
const generated = (count: number) => Array.from({ length: count }, (_, i) => `func gen${String(i).padStart(8, '0')}() {}`).join('\n') + '\n'

describe('Swift results in the parse cache (#988, #1148)', () => {
  it('keeps an ordinary Swift result and serves the next request for the same content from it', async () => {
    clearParseCache()
    const source = 'import Foundation\npublic struct Store { func load() {} }\n'
    const first = await parsed('swift', source, 'Sources/Store.swift', 'swift-small')
    expect(first.symbols.map((s) => s.name)).toEqual(['Store', 'load'])
    expect(parseCacheStats).toMatchObject({ parsed: 1, reused: 0, skippedLarge: 0 })
    expect(parseCacheStats.bytes).toBe(estimateExtractionBytes(first))
    const again = await parsed('swift', source, 'Sources/Store.swift', 'swift-small')
    expect(again).toBe(first)
    expect(parseCacheStats).toMatchObject({ parsed: 1, reused: 1 })
  })

  it('returns, and does not keep, a result cut at the child’s item limit, which is over the per-entry cap', async () => {
    clearParseCache()
    const source = generated(MAX_RESULT_ITEMS + 1_000)
    const result = await parsed('swift', source, 'Sources/Gen.swift', 'swift-big')
    expect(result.skipped).toBeUndefined()
    expect(result.symbols).toHaveLength(MAX_RESULT_ITEMS)
    expect(result.truncated).toMatch(/^1000 symbols or imports left out/)
    expect(estimateExtractionBytes(result)).toBeGreaterThan(PARSE_CACHE_ENTRY_BYTES)
    // Counted as parsed and as too large; nothing is held, so the same content is parsed again.
    expect(parseCacheStats).toMatchObject({ parsed: 1, reused: 0, skippedLarge: 1, bytes: 0 })
    const again = await parsed('swift', source, 'Sources/Gen.swift', 'swift-big')
    expect(again.symbols).toHaveLength(MAX_RESULT_ITEMS)
    expect(parseCacheStats).toMatchObject({ parsed: 2, reused: 0, skippedLarge: 2, bytes: 0 })
  }, 60_000)

  it('does not keep a skipped Swift file either', async () => {
    clearParseCache()
    process.env.ELARA_ISOLATED_PARSE_TIMEOUT_MS = '1'
    try {
      const result = await parsed('swift', generated(20_000), 'Sources/Slow.swift', 'swift-slow')
      expect(result.skipped).toMatch(/^swift symbols not extracted: the parse took longer than 1 ms/)
    } finally {
      delete process.env.ELARA_ISOLATED_PARSE_TIMEOUT_MS
    }
    expect(parseCacheStats).toMatchObject({ parsed: 0, reused: 0, skippedLarge: 0, bytes: 0 })
  }, 60_000)
})
