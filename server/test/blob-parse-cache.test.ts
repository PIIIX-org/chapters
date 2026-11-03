// #684 part B: a content parsed once in this process is not parsed again for the same grammar and extractor version.
import { beforeEach, describe, expect, it } from 'vitest'
import { clearParseCache, parseCacheStats, parsed } from '../src/repositories/blob-cache.js'

const SOURCE = 'export function one() {\n  return 1\n}\n'

beforeEach(clearParseCache)

describe('parsed (#684)', () => {
  it('parses a content once and returns the same result for the same hash, language and grammar', async () => {
    const first = await parsed('typescript', SOURCE, 'src/a.ts', 'h1')
    const second = await parsed('typescript', SOURCE, 'src/b.ts', 'h1')
    expect(second).toBe(first)
    expect(first.symbols.map((s) => s.name)).toEqual(['one'])
    expect(parseCacheStats).toEqual({ parsed: 1, reused: 1 })
  })

  it('keeps a content parsed with another grammar (.ts, .tsx) or another hash apart', async () => {
    await parsed('typescript', SOURCE, 'src/a.ts', 'h1')
    await parsed('typescript', SOURCE, 'src/a.tsx', 'h1')
    await parsed('typescript', SOURCE, 'src/a.ts', 'h2')
    expect(parseCacheStats).toEqual({ parsed: 3, reused: 0 })
  })
})
