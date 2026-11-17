// #1148: the parse cache is bounded by estimated bytes (ELARA_PARSE_CACHE_MB), not only by entries: the oldest
// results go when the budget is exceeded, and a result over the per-entry cap is returned and not kept. A fake
// extractor builds results of a chosen size; only `parsed`, `clearParseCache` and `parseCacheStats.parsed/reused`
// are used, so this file fails on assertions (not on a missing export) against a cache without a byte bound.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearParseCache, parseCacheStats, parsed } from '../src/repositories/blob-cache.js'
import type { ExtractionResult } from '../src/repositories/extraction.js'

vi.mock('../src/repositories/extraction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/repositories/extraction.js')>()),
  // The content of a fake file is the number of characters of its one symbol name: an estimate of ~2 bytes each.
  extractStructure: vi.fn(async (_language: string, content: string): Promise<ExtractionResult> => ({
    imports: [],
    symbols: [{ name: 'x'.repeat(Number(content)), kind: 'function', startLine: 1, endLine: 2, exported: true }],
    sites: [],
  })),
}))

const MIB = 1024 * 1024
/** ~3 MB estimated (2 bytes a character): under the 4 MiB per-entry cap, three of them over an 8 MiB budget. */
const LARGE = String(1_500_000)
/** ~10 MB estimated: over the per-entry cap and over an 8 MiB budget. */
const HUGE = String(5_000_000)

const budget = process.env.ELARA_PARSE_CACHE_MB
beforeEach(() => {
  process.env.ELARA_PARSE_CACHE_MB = '8'
  clearParseCache()
})
afterEach(() => {
  if (budget === undefined) delete process.env.ELARA_PARSE_CACHE_MB
  else process.env.ELARA_PARSE_CACHE_MB = budget
})

const parse = (content: string, hash: string) => parsed('typescript', content, 'src/a.ts', hash)

describe('parsed byte budget (#1148)', () => {
  it('evicts the oldest results when large ones exceed the byte budget under the entry limit', async () => {
    await parse(LARGE, 'a')
    await parse(LARGE, 'b')
    expect(parseCacheStats).toMatchObject({ parsed: 2, reused: 0 })
    await parse(LARGE, 'c') // three of ~3 MB over 8 MiB: `a`, the oldest, goes
    expect(parseCacheStats).toMatchObject({ parsed: 3, reused: 0 })

    await parse(LARGE, 'c')
    await parse(LARGE, 'b')
    expect(parseCacheStats).toMatchObject({ parsed: 3, reused: 2 }) // the two newest are still held
    await parse(LARGE, 'a')
    expect(parseCacheStats).toMatchObject({ parsed: 4, reused: 2 }) // the oldest was parsed again
  })

  it('evicts the least recently used result, not the oldest inserted', async () => {
    await parse(LARGE, 'a')
    await parse(LARGE, 'b')
    await parse(LARGE, 'a') // `a` is now the most recent
    await parse(LARGE, 'c') // evicts `b`
    expect(parseCacheStats).toMatchObject({ parsed: 3, reused: 1 })
    await parse(LARGE, 'a')
    await parse(LARGE, 'c')
    expect(parseCacheStats).toMatchObject({ parsed: 3, reused: 3 })
    await parse(LARGE, 'b')
    expect(parseCacheStats).toMatchObject({ parsed: 4, reused: 3 })
  })

  it('returns a result over the per-entry cap and does not retain it', async () => {
    const first = await parse(HUGE, 'big')
    expect(first.symbols[0]!.name).toHaveLength(5_000_000)
    const second = await parse(HUGE, 'big')
    expect(second.symbols[0]!.name).toHaveLength(5_000_000)
    expect(parseCacheStats).toMatchObject({ parsed: 2, reused: 0 })
  })

  it('does not let an over-cap result push out the results already held', async () => {
    await parse('10', 'small')
    await parse(HUGE, 'big')
    await parse('10', 'small')
    expect(parseCacheStats).toMatchObject({ parsed: 2, reused: 1 })
  })

  it('still reuses small results as before', async () => {
    const first = await parse('10', 'one')
    const second = await parse('10', 'one')
    expect(second).toBe(first)
    expect(parseCacheStats).toMatchObject({ parsed: 1, reused: 1 })
  })

  it('caps one entry at the budget when the budget is below the per-entry cap', async () => {
    process.env.ELARA_PARSE_CACHE_MB = '1'
    await parse(String(MIB), 'over') // ~2 MiB estimated against a 1 MiB budget
    await parse(String(MIB), 'over')
    expect(parseCacheStats).toMatchObject({ parsed: 2, reused: 0 })
  })
})
