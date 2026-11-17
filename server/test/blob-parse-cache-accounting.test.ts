// #1148: the parse cache's byte accounting, its size estimate and the ELARA_PARSE_CACHE_MB reader.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PARSE_CACHE_ENTRY_BYTES, clearParseCache, estimateExtractionBytes, parseCacheStats, parsed } from '../src/repositories/blob-cache.js'
import { DEFAULT_PARSE_CACHE_MB, config, readParseCacheMb } from '../src/config.js'
import type { ExtractionResult } from '../src/repositories/extraction.js'

vi.mock('../src/repositories/extraction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/repositories/extraction.js')>()),
  // The content of a fake file is the number of characters of its one symbol name.
  extractStructure: vi.fn(async (_language: string, content: string): Promise<ExtractionResult> => ({
    imports: [],
    symbols: [{ name: 'x'.repeat(Number(content)), kind: 'function', startLine: 1, endLine: 2, exported: true }],
    sites: [],
  })),
}))

const MIB = 1024 * 1024
const sized = (chars: number): ExtractionResult => ({
  imports: [],
  symbols: [{ name: 'x'.repeat(chars), kind: 'function', startLine: 1, endLine: 2, exported: true }],
  sites: [],
})

const budget = process.env.ELARA_PARSE_CACHE_MB
beforeEach(() => {
  process.env.ELARA_PARSE_CACHE_MB = '8'
  clearParseCache()
})
afterEach(() => {
  if (budget === undefined) delete process.env.ELARA_PARSE_CACHE_MB
  else process.env.ELARA_PARSE_CACHE_MB = budget
})

describe('estimateExtractionBytes (#1148)', () => {
  it('counts two bytes per character of every string and an overhead per item, at least', () => {
    const result: ExtractionResult = {
      imports: [{ target: 'abcd', line: 1 }],
      symbols: [{ name: 'ab', kind: 'method', parent: 'cde', startLine: 1, endLine: 2, exported: false }],
      sites: [{ kind: 'call', name: 'f', qualified: 'A.f', via: './m', member: false, local: null, enclosing: null, line: 1, col: 1 }],
    }
    const chars = 4 + (2 + 3) + (1 + 3 + 3)
    expect(estimateExtractionBytes(result)).toBeGreaterThan(chars * 2)
    expect(estimateExtractionBytes(result)).toBeGreaterThan(estimateExtractionBytes({ imports: [], symbols: [], sites: [] }) + chars * 2)
  })

  it('grows with the number of items and with the length of their strings', () => {
    const one = estimateExtractionBytes(sized(10))
    expect(estimateExtractionBytes(sized(1_010))).toBe(one + 2_000)
    const two: ExtractionResult = { imports: [], symbols: [...sized(10).symbols, ...sized(10).symbols], sites: [] }
    expect(estimateExtractionBytes(two)).toBeGreaterThan(one)
  })

  it('is cheap: an empty result is a small constant', () => {
    expect(estimateExtractionBytes({ imports: [], symbols: [], sites: [] })).toBeLessThan(1024)
  })
})

describe('parsed byte accounting (#1148)', () => {
  it('tracks the estimated total of the retained entries through insertions, reuse and evictions', async () => {
    const small = estimateExtractionBytes(sized(10))
    const large = estimateExtractionBytes(sized(1_500_000))
    expect(parseCacheStats.bytes).toBe(0)
    await parsed('typescript', '10', 'a.ts', 's1')
    await parsed('typescript', '10', 'a.ts', 's2')
    await parsed('typescript', '10', 'a.ts', 's1') // a reuse adds nothing
    expect(parseCacheStats.bytes).toBe(2 * small)

    await parsed('typescript', '1500000', 'a.ts', 'l1')
    await parsed('typescript', '1500000', 'a.ts', 'l2') // 2 small + 2 large = ~6 MB: all fit in 8 MiB
    expect(parseCacheStats.bytes).toBe(2 * small + 2 * large)
    await parsed('typescript', '1500000', 'a.ts', 'l3') // ~9 MB over 8 MiB: s2, s1 and l1 go, oldest first
    expect(parseCacheStats.bytes).toBe(2 * large)
    const parsedBefore = parseCacheStats.parsed
    await parsed('typescript', '1500000', 'a.ts', 'l2')
    await parsed('typescript', '1500000', 'a.ts', 'l3')
    expect(parseCacheStats.parsed).toBe(parsedBefore) // the survivors are the two newest
  })

  it('sums exactly the retained entries after evictions', async () => {
    const large = estimateExtractionBytes(sized(1_500_000))
    await parsed('typescript', '1500000', 'a.ts', 'a')
    await parsed('typescript', '1500000', 'a.ts', 'b')
    expect(parseCacheStats.bytes).toBe(2 * large)
    await parsed('typescript', '1500000', 'a.ts', 'c') // `a` goes
    expect(parseCacheStats.bytes).toBe(2 * large)
    expect(parseCacheStats.bytes).toBeLessThanOrEqual(8 * MIB)
  })

  it('does not count a result over the per-entry cap and counts the skip', async () => {
    const small = estimateExtractionBytes(sized(10))
    await parsed('typescript', '10', 'a.ts', 'small')
    await parsed('typescript', '5000000', 'a.ts', 'big')
    await parsed('typescript', '5000000', 'a.ts', 'big')
    expect(estimateExtractionBytes(sized(5_000_000))).toBeGreaterThan(PARSE_CACHE_ENTRY_BYTES)
    expect(parseCacheStats).toMatchObject({ parsed: 3, reused: 0, skippedLarge: 2, bytes: small })
  })

  it('counts a key stored by two concurrent parses once', async () => {
    const small = estimateExtractionBytes(sized(10))
    await Promise.all([parsed('typescript', '10', 'a.ts', 'same'), parsed('typescript', '10', 'a.ts', 'same')])
    expect(parseCacheStats).toMatchObject({ parsed: 2, bytes: small })
  })

  it('returns to zero bytes and zero skips after clearParseCache', async () => {
    await parsed('typescript', '10', 'a.ts', 'a')
    await parsed('typescript', '5000000', 'a.ts', 'big')
    expect(parseCacheStats.bytes).toBeGreaterThan(0)
    expect(parseCacheStats.skippedLarge).toBe(1)
    clearParseCache()
    expect(parseCacheStats).toEqual({ parsed: 0, reused: 0, skippedLarge: 0, bytes: 0 })
  })
})

describe('readParseCacheMb (#1148)', () => {
  it('uses the default when unset or empty', () => {
    expect(readParseCacheMb(undefined)).toBe(DEFAULT_PARSE_CACHE_MB)
    expect(readParseCacheMb('')).toBe(DEFAULT_PARSE_CACHE_MB)
    expect(DEFAULT_PARSE_CACHE_MB).toBe(64)
  })

  it('accepts positive whole numbers of MiB', () => {
    expect(readParseCacheMb('1')).toBe(1)
    expect(readParseCacheMb('256')).toBe(256)
  })

  it('rejects zero, negatives, fractions, whitespace and text', () => {
    for (const bad of ['0', '-1', '1.5', ' ', '\t', '64MB', 'abc', '1e3x', String(2 ** 60)]) expect(readParseCacheMb(bad)).toBeNull()
  })

  it('reaches the cache as bytes, and a bad value falls back to the default', () => {
    expect(config.parseCacheBytes).toBe(8 * MIB)
    process.env.ELARA_PARSE_CACHE_MB = 'nope'
    expect(config.parseCacheBytes).toBe(DEFAULT_PARSE_CACHE_MB * MIB)
  })
})
