// node --test benchmarks/lib/*.test.ts (CI: checks job)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aggregate,
  exactAtK,
  dcg,
  dedupe,
  estimateTokens,
  firstRelevantRank,
  hitAtK,
  LineSet,
  linePrecisionRecall,
  median,
  ndcgAtK,
  pairedTokensToGold,
  reciprocalRank,
  type QuestionOutcome,
} from './metrics.ts'

const rel = (...docs: Array<[string, number]>) => new Map(docs)

/** Deterministic PRNG for the property tests (same sequence on every run). */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('dedupe keeps the first occurrence in order', () => {
  assert.deepEqual(dedupe(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c'])
})

test('hit@k, first relevant rank and reciprocal rank', () => {
  const j = rel(['c', 1])
  assert.equal(firstRelevantRank(['a', 'b', 'c'], j), 3)
  assert.equal(hitAtK(['a', 'b', 'c'], j, 1), 0)
  assert.equal(hitAtK(['a', 'b', 'c'], j, 3), 1)
  assert.equal(reciprocalRank(['a', 'b', 'c'], j), 1 / 3)
  assert.equal(firstRelevantRank(['a', 'b'], j), null)
  assert.equal(reciprocalRank(['a', 'b'], j), 0)
  assert.equal(hitAtK([], j, 10), 0)
})

test('repeats do not move a document down or credit it twice', () => {
  const j = rel(['b', 1])
  // 'a' twice: b is the second distinct document, not the third.
  assert.equal(firstRelevantRank(['a', 'a', 'b'], j), 2)
  assert.equal(hitAtK(['a', 'a', 'b'], j, 2), 1)
})

test('dcg uses gain / log2(rank + 1)', () => {
  assert.equal(dcg([1], 10), 1)
  assert.ok(Math.abs(dcg([0, 1], 10) - 1 / Math.log2(3)) < 1e-12)
  assert.equal(dcg([1, 1, 1], 2), 1 + 1 / Math.log2(3))
})

test('NDCG: a perfect ranking scores exactly 1', () => {
  assert.equal(ndcgAtK(['a'], rel(['a', 1]), 10), 1)
  assert.equal(ndcgAtK(['a', 'b', 'c'], rel(['a', 1], ['b', 1], ['c', 1]), 10), 1)
  // Graded: best grade first is the ideal.
  assert.equal(ndcgAtK(['a', 'b', 'x'], rel(['a', 3], ['b', 1]), 10), 1)
})

test('NDCG: no relevant document returned scores 0', () => {
  assert.equal(ndcgAtK(['x', 'y'], rel(['a', 1]), 10), 0)
  assert.equal(ndcgAtK([], rel(['a', 1]), 10), 0)
})

test('NDCG: a relevant document returned many times still scores at most 1', () => {
  // Crediting every repeat gives DCG 1 + 1/log2(3) + 1/2 = 2.13 against an
  // IDCG of 1: a value NDCG cannot take.
  assert.equal(ndcgAtK(['a', 'a', 'a'], rel(['a', 1]), 10), 1)
})

test('NDCG: every judged relevance enters the ideal (the TP-01 bug)', () => {
  // TP-01 hardcoded its ideal DCG for a single exact match while it credited
  // relevance to every file in the same folder, so a list of three relevant
  // files scored 2.13 against an ideal of 1 (it reported 1.37). Here the
  // ideal is built from all three judgments: the same list scores exactly 1.
  assert.equal(ndcgAtK(['a', 'b', 'c'], rel(['a', 1], ['b', 1], ['c', 1]), 10), 1)
})

test('NDCG: the ideal comes from the judgments, not from what was returned', () => {
  // Two relevant documents judged, one returned at rank 2. An IDCG built
  // from the returned list alone would be 1/log2(3) and give NDCG = 1.
  const got = ndcgAtK(['x', 'a'], rel(['a', 1], ['b', 1]), 10)
  const expected = 1 / Math.log2(3) / (1 + 1 / Math.log2(3))
  assert.ok(Math.abs(got - expected) < 1e-12, `${got} != ${expected}`)
  assert.ok(got < 1)
})

test('NDCG: the ideal is cut at k like the ranking', () => {
  // 12 relevant documents, all 10 slots relevant: perfect at k = 10.
  const docs = Array.from({ length: 12 }, (_, i) => `d${i}`)
  const j = new Map(docs.map((d) => [d, 1]))
  assert.equal(ndcgAtK(docs.slice(0, 10), j, 10), 1)
})

test('NDCG property: always in [0, 1] for random rankings and graded judgments', () => {
  const rand = prng(570)
  for (let trial = 0; trial < 2000; trial++) {
    const pool = Array.from({ length: 30 }, (_, i) => `d${i}`)
    const j = new Map<string, number>()
    const nRel = 1 + Math.floor(rand() * 8)
    for (let i = 0; i < nRel; i++) j.set(pool[Math.floor(rand() * pool.length)]!, 1 + Math.floor(rand() * 3))
    // Rankings with repeats and unjudged documents.
    const ranking = Array.from({ length: Math.floor(rand() * 25) }, () => pool[Math.floor(rand() * pool.length)]!)
    const k = 1 + Math.floor(rand() * 12)
    const v = ndcgAtK(ranking, j, k)
    assert.ok(v >= 0 && v <= 1 + 1e-12, `NDCG@${k} = ${v} for ${JSON.stringify(ranking)} / ${JSON.stringify([...j])}`)
    // The ideal ordering of the judged documents scores 1.
    const ideal = [...j.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d)
    assert.ok(Math.abs(ndcgAtK(ideal, j, k) - 1) < 1e-12)
  }
})

test('metrics refuse a question without a relevant document', () => {
  assert.throws(() => ndcgAtK(['a'], new Map(), 10), /at least one relevant/)
  assert.throws(() => firstRelevantRank(['a'], rel(['a', 0])), /> 0/)
})

test('line precision and recall', () => {
  const gold = [
    { path: 'f', start: 10, end: 14 },
    { path: 'g', start: 1, end: 1 },
  ]
  const seen = new LineSet()
  assert.deepEqual(linePrecisionRecall(gold, seen), { precision: 0, recall: 0 })
  seen.add('f', 1, 20) // 20 lines, 5 of them gold
  assert.deepEqual(linePrecisionRecall(gold, seen), { precision: 5 / 20, recall: 5 / 6 })
  seen.add('g', 1, 1)
  assert.deepEqual(linePrecisionRecall(gold, seen), { precision: 6 / 21, recall: 1 })
  // Exactly the gold: both 1.
  const exact = new LineSet()
  exact.add('f', 10, 14)
  exact.add('g', 1, 1)
  assert.deepEqual(linePrecisionRecall(gold, exact), { precision: 1, recall: 1 })
})

test('overlapping gold ranges count each line once', () => {
  const gold = [
    { path: 'f', start: 1, end: 10 },
    { path: 'f', start: 5, end: 12 },
  ]
  const seen = new LineSet()
  seen.add('f', 1, 12)
  assert.deepEqual(linePrecisionRecall(gold, seen), { precision: 1, recall: 1 })
})

test('LineSet coverage and size', () => {
  const s = new LineSet()
  s.add('f', 3, 5)
  s.add('f', 4, 8)
  s.add('f', 9, 2) // empty range ignored
  assert.equal(s.size, 6)
  assert.ok(s.covers({ path: 'f', start: 3, end: 8 }))
  assert.ok(!s.covers({ path: 'f', start: 2, end: 3 }))
  assert.ok(!s.covers({ path: 'g', start: 3, end: 3 }))
})

test('tokens are characters / 4 rounded up', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abc'), 1)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
})

test('median', () => {
  assert.equal(median([]), 0)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('aggregate: means over questions, misses cost the miss price', () => {
  const gold = [{ path: 'a', start: 10, end: 12 }]
  const base = { judgments: rel(['a', 1]), gold, hits: [] as Array<{ path: string; start: number; end: number } | null>, abstained: false, route: 'conceptual' as 'identifier' | 'path' | 'conceptual', callsToGold: 2, tokensToAllGold: null, precision: 0.5, recall: 1, tokens: 300, calls: 2, ms: 10 }
  const outcomes: QuestionOutcome[] = [
    { ...base, ranking: ['a'], hits: [{ path: 'a', start: 9, end: 20 }], tokensToGold: 100 },
    { ...base, ranking: ['x', 'y', 'z', 'w', 'v', 'a'], hits: [null, { path: 'a', start: 11, end: 11 }], tokensToGold: 300 },
    { ...base, ranking: ['x'], abstained: true, tokensToGold: null, callsToGold: null, precision: 0, recall: 0 },
  ]
  const a = aggregate(outcomes, 1000, 15)
  assert.equal(a.questions, 3)
  assert.equal(a.hit1, 0.3333)
  assert.equal(a.hit5, 0.3333)
  assert.equal(a.hit10, 0.6667)
  assert.equal(a.mrr, Math.round(((1 + 1 / 6) / 3) * 10_000) / 10_000)
  assert.equal(a.goldReached, 2)
  assert.equal(a.goldReachedRate, 0.6667)
  assert.equal(a.exact1, 0.3333)
  assert.equal(a.exact5, 0.6667)
  assert.equal(a.abstained, 0.3333)
  assert.equal(a.tokensToGold, Math.round((100 + 300 + 1000) / 3))
  assert.equal(a.tokensToGoldMedian, 300)
  assert.equal(a.tokensToGoldReached, 200) // (100 + 300) / 2, the miss left out
  assert.deepEqual(pairedTokensToGold(outcomes, [outcomes[1]!, outcomes[0]!, outcomes[2]!]), { questions: 2, elara: 200, grep: 200 })
  assert.equal(a.callsToGold, Math.round(((2 + 2 + 15) / 3) * 10_000) / 10_000)
  assert.equal(a.linePrecision, 0.3333)
  assert.equal(a.lineRecall, 0.6667)
  assert.ok(a.ndcg10 >= 0 && a.ndcg10 <= 1)
})

test('an answer that abstained scores no exact hit, whatever locations it offered (#1058 review)', () => {
  const gold = [{ path: 'a', start: 1, end: 2 }]
  const base = { judgments: rel(['a', 1]), gold, hits: [{ path: 'a', start: 1, end: 2 }], callsToGold: 1, tokensToAllGold: 1, precision: 1, recall: 1, tokens: 1, calls: 1, ms: 1, ranking: ['a'], tokensToGold: 1 }
  const a = aggregate([{ ...base, abstained: false, route: 'conceptual' as const }, { ...base, abstained: true, route: 'conceptual' as const }], 1000, 15)
  assert.equal(a.exact1, 0.5)
  assert.equal(a.exact5, 0.5)
  assert.equal(a.abstained, 0.5)
})

test('exactAtK: the first k returned locations overlap a gold range of the same file', () => {
  const gold = [{ path: 'a.ts', start: 10, end: 12 }, { path: 'b.ts', start: 1, end: 1 }]
  const at = (path: string, start: number, end: number) => ({ path, start, end })
  assert.equal(exactAtK([at('a.ts', 12, 40)], gold, 1), 1, 'one shared line is an overlap')
  assert.equal(exactAtK([at('a.ts', 13, 40)], gold, 1), 0, 'the next line is not')
  assert.equal(exactAtK([at('c.ts', 10, 12)], gold, 1), 0, 'another file is not')
  assert.equal(exactAtK([null, at('b.ts', 1, 9)], gold, 1), 0, 'the second place is not first')
  assert.equal(exactAtK([null, at('b.ts', 1, 9)], gold, 5), 1)
  assert.equal(exactAtK([null, null, null, null, null, at('a.ts', 10, 10)], gold, 5), 0, 'the sixth is past k')
  assert.equal(exactAtK([], gold, 1), 0)
})

test('routed questions are counted, and exact1 over them alone (#1060)', () => {
  const gold = [{ path: 'a', start: 1, end: 2 }]
  const base = { judgments: rel(['a', 1]), gold, callsToGold: 1, tokensToAllGold: 1, precision: 1, recall: 1, tokens: 1, calls: 1, ms: 1, ranking: ['a'], tokensToGold: 1, abstained: false }
  const a = aggregate(
    [
      { ...base, route: 'identifier', hits: [{ path: 'a', start: 2, end: 9 }] },
      { ...base, route: 'path', hits: [{ path: 'b', start: 1, end: 9 }] },
      { ...base, route: 'conceptual', hits: [{ path: 'a', start: 1, end: 1 }] },
      { ...base, route: 'conceptual', hits: [] },
    ],
    1000,
    15,
  )
  assert.equal(a.routed, 0.5)
  assert.equal(a.exact1Routed, 0.5)
  assert.equal(a.exact1, 0.5)
  assert.equal(aggregate([{ ...base, route: 'conceptual', hits: [] }], 1000, 15).exact1Routed, 0)
})

test('all route classes and failed lookup attempts are measured separately', () => {
  const base = { judgments: rel(['a', 1]), gold: [{ path: 'a', start: 1, end: 2 }], callsToGold: 1, tokensToAllGold: 1, precision: 1, recall: 1, tokens: 1, calls: 1, ms: 1, ranking: ['a'], tokensToGold: 1, abstained: false, hits: [{ path: 'a', start: 1, end: 2 }] }
  const measured = aggregate([
    { ...base, route: 'identifier' },
    { ...base, route: 'path' },
    { ...base, route: 'structural' },
    { ...base, route: 'conceptual', attemptedRoute: 'identifier', hits: [], ranking: [] },
  ], 1000, 15)
  assert.equal(measured.identifierQuestions, 1)
  assert.equal(measured.identifierAttempts, 2)
  assert.equal(measured.identifierExact1, 1)
  assert.equal(measured.identifierExact1Attempts, 0.5)
  assert.equal(measured.identifierFallbacks, 1)
  assert.equal(measured.pathQuestions, 1)
  assert.equal(measured.pathExact1, 1)
  assert.equal(measured.structuralQuestions, 1)
  assert.equal(measured.structuralExact1, 1)
  assert.equal(measured.conceptualQuestions, 1)
  assert.equal(measured.conceptualExact1, 0)
  assert.ok(Object.values(measured).every((value) => typeof value === 'number'))
  assert.equal(measured.routed, 0.75)
})

test('independent identifier cohort includes fallback, miss and ambiguous cases', () => {
  const base = { judgments: rel(['a', 1]), gold: [{ path: 'a', start: 1, end: 2 }], callsToGold: 1, tokensToAllGold: 1, precision: 1, recall: 1, tokens: 1, calls: 1, ms: 1, ranking: ['a'], tokensToGold: 1, abstained: false, hits: [{ path: 'a', start: 1, end: 2 }], category: 'identifier' }
  const measured = aggregate([
    { ...base, route: 'identifier' },
    { ...base, route: 'conceptual', attemptedRoute: 'identifier', hits: [], ranking: [] },
    { ...base, route: 'identifier', abstained: true },
    { ...base, route: 'conceptual', category: 'architecture' },
  ], 1000, 15)
  assert.equal(measured.identifierCohortQuestions, 3)
  assert.equal(measured.identifierCohortExact1, 0.3333)
})
