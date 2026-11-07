// #1061: the verdict rule, the Latin check, the passage text and the fake verifier.
import { describe, expect, it } from 'vitest'
import { FakeVerifier, decide, hitText, isLatinQuery } from '../src/search/verifier.js'

describe('decide', () => {
  it('commits when one passage is clearly ahead, with the margin as confidence', () => {
    expect(decide([0.1, 0.96, 0.2])).toEqual({ order: [1, 2, 0], confidence: 0.76, answer: true, ambiguous: false })
  })
  it('is ambiguous when two likely passages are close', () => {
    expect(decide([0.8, 0.85])).toEqual({ order: [1, 0], confidence: 0.05, answer: false, ambiguous: true })
  })
  it('keeps the fused order among equal scores and says nothing when all are low', () => {
    expect(decide([0.2, 0.2, 0.1])).toEqual({ order: [0, 1, 2], confidence: 0, answer: false, ambiguous: false })
  })
})

describe('isLatinQuery', () => {
  it('reads every letter: Latin and digits pass, any other script does not', () => {
    for (const q of ['where is `parseNote`', 'rate limits 429', 'café', '#1061']) expect(isLatinQuery(q), q).toBe(true)
    for (const q of ['برداشت کیوی', 'kiwi كيوي', 'привет', '日本語']) expect(isLatinQuery(q), q).toBe(false)
  })
})

describe('hitText and the fake verifier', () => {
  it('names a symbol, then its path and snippet without highlight marks', () => {
    expect(hitText({ path: 'src/a.ts', snippet: 'the <b>kiwi</b>', symbolName: 'save', symbolKind: 'method', symbolParent: 'Store' })).toBe('method Store.save\nsrc/a.ts\nthe kiwi')
  })
  it('scores the share of the query words a passage holds', async () => {
    expect(await new FakeVerifier().score('kiwi harvest autumn', ['kiwi harvest', 'nothing', 'autumn kiwi harvest'])).toEqual([2 / 3, 0, 1])
  })
})
