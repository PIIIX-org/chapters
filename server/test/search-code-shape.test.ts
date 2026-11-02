// #457: the code-shaped query classifier. Its own file: the tests of the ranking itself (search-code-above-docs.test.ts)
// reach it through exports the base already has, so they can fail on an assertion there.
import { describe, expect, it } from 'vitest'
import { isCodeShaped } from '../src/search/search.js'

describe('isCodeShaped (#457)', () => {
  it('isCodeShaped rejects prose queries with tech brands, slashes, parens, and rationale questions', () => {
    // False positive cases flagged by review:
    expect(isCodeShaped('and/or condition handling')).toBe(false)
    expect(isCodeShaped('installing via curl/wget on Linux')).toBe(false)
    expect(isCodeShaped('differences between Node/V8 runtime')).toBe(false)
    expect(isCodeShaped('How do you compile to WebAssembly')).toBe(false)
    expect(isCodeShaped('Where are the issues on GitHub')).toBe(false)
    expect(isCodeShaped('REST and GraphQL APIs overview')).toBe(false)
    expect(
      isCodeShaped('Why does the codebase forbid unwrap() in shipped code'),
    ).toBe(false)
    expect(
      isCodeShaped('Which semantic pattern routes to the visual type'),
    ).toBe(false)
    expect(isCodeShaped('How to export the diagram to SVG')).toBe(false)
    expect(
      isCodeShaped(
        'Why do SessionDB and ContentStore allow multiple writer processes on the same database file instead of using a lock file?',
      ),
    ).toBe(false)
  })

  it('isCodeShaped accepts genuine code queries', () => {
    expect(isCodeShaped('where is src/config/parser.ts')).toBe(true)
    expect(isCodeShaped('function parseConfig')).toBe(true)
    expect(isCodeShaped('export class HopperRequestQueue')).toBe(true)
    expect(isCodeShaped('def parse_frontmatter')).toBe(true)
    expect(isCodeShaped('crates/engine/src/guard.rs')).toBe(true)
  })

  it('a capitalised product name such as Node.js is not a file signal', () => {
    expect(isCodeShaped('install Node.js on macOS')).toBe(false)
    expect(isCodeShaped('where is server.js started')).toBe(true)
  })
})
