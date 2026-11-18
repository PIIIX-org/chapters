// #1148: what the cache retains is what it charges. V8 keeps a `slice` of a long text as a view into it, so a result
// whose names are cut out of a ~0.9 MB source could pin the whole source while being estimated at a few hundred
// bytes. Real extraction (no mock), real heap: the retained heap per cached result must stay far below the source size.
import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'
import { beforeAll, describe, expect, it } from 'vitest'
import { clearParseCache, parseCacheStats, parsed } from '../src/repositories/blob-cache.js'

/** `gc()` without a `--expose-gc` flag on the runner: the flag can be switched on at runtime. A missing gc fails the test. */
function collect(): void {
  const gc = (globalThis as { gc?: () => void }).gc ?? (runInNewContext('gc') as (() => void) | undefined)
  if (typeof gc !== 'function') throw new Error('gc is unavailable: this test measures the heap and cannot skip')
  gc()
  gc()
}

beforeAll(() => {
  setFlagsFromString('--expose-gc')
})

const PAD = (comment: string, i: number) => (comment + i + ' ' + 'y'.repeat(90) + '\n').repeat(9000)
/** One distinct ~0.9 MB source per index: newline-bounded comment padding, then one short function and call sites. */
const CASES: Array<{ language: string; path: string; source: (i: number) => string }> = [
  { language: 'python', path: 'a.py', source: (i) => `${PAD('# c', i)}from mod${i} import helper_one\ndef name_number${i}():\n  helper_one()\n  self.member_call${i}()\n` },
  { language: 'rust', path: 'a.rs', source: (i) => `${PAD('// c', i)}use crate::mod${i}::helper_one;\npub fn name_number${i}() { helper_one(); self.member_call${i}() }\n` },
  { language: 'java', path: 'A.java', source: (i) => `${PAD('// c', i)}import mod${i}.HelperOne;\nclass NameNumber${i} { void m() { HelperOne.run(); this.memberCall${i}(); } }\n` },
  { language: 'typescript', path: 'a.ts', source: (i) => `${PAD('// c', i)}import { helperOne } from './mod${i}'\nexport function nameNumber${i}() { helperOne(); this.memberCall${i}() }\n` },
  // Swift is parsed in a child process and arrives over IPC as JSON: its strings are already this process's own,
  // never views into the 0.9 MB source (which stays in the child), and `parsed` detaches them like the others.
  { language: 'swift', path: 'A.swift', source: (i) => `${PAD('// c', i)}import Mod${i}\npublic func nameNumber${i}() { helperOne(); self.memberCall${i}() }\n` },
]
const SOURCES = 25
const SOURCE_BYTES = 800_000
/** A small, fixed allowance per result for its own objects and strings: two orders of magnitude under the source. */
const RETAINED_PER_RESULT = 50_000

describe('parse cache retention (#1148)', () => {
  for (const { language, path, source } of CASES) {
    it(`does not pin the ${language} source text behind a cached result`, async () => {
      clearParseCache()
      await parsed(language, source(0), path, 'warm-up') // loads the grammar: not part of what is measured
      clearParseCache()
      collect()
      const before = process.memoryUsage().heapUsed
      const kept = []
      for (let i = 1; i <= SOURCES; i++) {
        const text = source(i)
        expect(text.length).toBeGreaterThan(SOURCE_BYTES)
        kept.push(await parsed(language, text, path, `h${i}`))
      }
      collect()
      const retained = process.memoryUsage().heapUsed - before
      expect(kept.every((r) => r.symbols.length > 0)).toBe(true)
      expect(parseCacheStats).toMatchObject({ parsed: SOURCES, reused: 0, skippedLarge: 0 })
      // 25 pinned sources are ~20 MB; the results themselves are a few KB each.
      expect(retained / SOURCES).toBeLessThan(RETAINED_PER_RESULT)
      expect(kept).toHaveLength(SOURCES)
    }, 120_000)
  }
})
