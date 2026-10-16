// Unit tests for bench-gate.mjs (#570).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compare, evaluate, movement, render, toBaseline, TOLERANCE } from './bench-gate.mjs'

const agg = (over = {}) => ({
  questions: 20,
  hit1: 0.4,
  hit5: 0.6,
  hit10: 0.7,
  mrr: 0.5,
  ndcg10: 0.5,
  goldReached: 12,
  tokensToGold: 20_000,
  tokensToGoldMedian: 9_000,
  callsToGold: 6,
  linePrecision: 0.01,
  lineRecall: 0.5,
  tokens: 15_000,
  calls: 5,
  msMedian: 900,
  ...over,
})

function results(elara = {}, { fingerprint = 'fp1', outcome = 'complete', suites = ['s'] } = {}) {
  return {
    commit: 'abc',
    runUrl: 'https://github.com/PIIIX-org/chapters/actions/runs/1',
    selected: suites,
    missCost: { tokens: 65_000, calls: 15 },
    suites: Object.fromEntries(
      suites.map((name) => [
        name,
        {
          fingerprint,
          questions: 20,
          index: { outcome, files: 100, symbols: 50, ms: 60_000 },
          aggregate: { elara: agg(elara), grep: agg({ hit5: 0.8, tokensToGold: 9_000 }) },
          perQuestion: [{ id: 'Q1', elara: { rank: 1, tokensToGold: 500 }, grep: { rank: 2, tokensToGold: 300 } }],
        },
      ]),
    ),
  }
}

const baselineOf = (r) => toBaseline(r)

describe('movement', () => {
  it('hit@5 tolerates the configured number of questions', () => {
    const one = TOLERANCE.hit5Questions / 20
    assert.equal(movement('hit5', 0.6, 0.6 - one, 20), 'same')
    assert.equal(movement('hit5', 0.6, 0.6 - one - 0.05, 20), 'worse')
    assert.equal(movement('hit5', 0.6, 0.6 + one + 0.05, 20), 'better')
    // 28/29 and 27/29 as written by round4 (0.9655 -> 0.931 is one question, PR #622's first run).
    assert.equal(movement('hit5', 0.9655, 0.931, 29), 'same')
    assert.equal(movement('hit5', 0.9655, 0.8966, 29), 'worse')
  })

  it('tokens-to-gold is relative, and lower is better', () => {
    const tol = TOLERANCE.tokensRelative
    assert.equal(movement('tokensToGold', 10_000, 10_000 * (1 + tol) - 1, 20), 'same')
    assert.equal(movement('tokensToGold', 10_000, 10_000 * (1 + tol) + 1, 20), 'worse')
    assert.equal(movement('tokensToGold', 10_000, 10_000 * (1 - tol) - 1, 20), 'better')
  })

  it('refuses ungated metrics', () => {
    assert.throws(() => movement('mrr', 1, 1, 1), /not gated/)
  })
})

describe('evaluate', () => {
  it('passes a run that matches its baseline', () => {
    const r = results()
    const report = evaluate({ results: r, baseline: baselineOf(r) })
    assert.deepEqual(report.failures, [])
    assert.equal(report.ok, true)
  })

  it('fails a regression of hit@5 or tokens-to-gold', () => {
    const base = baselineOf(results())
    const hit = evaluate({ results: results({ hit5: 0.45 }), baseline: base })
    assert.equal(hit.ok, false)
    assert.match(hit.failures.join('\n'), /regression, Elara hit5 0.6 -> 0.45/)
    const tok = evaluate({ results: results({ tokensToGold: 30_000 }), baseline: base })
    assert.match(tok.failures.join('\n'), /regression, Elara tokensToGold 20000 -> 30000/)
  })

  it('a PR cannot hide a regression by lowering its own baseline: the base baseline is the reference', () => {
    const base = baselineOf(results())
    const worse = results({ hit5: 0.3 })
    const report = evaluate({ results: worse, baseline: baselineOf(worse), baseBaseline: base })
    assert.equal(report.ok, false)
    assert.match(report.failures.join('\n'), /regression, Elara hit5 0.6 -> 0.3 \(base baseline/)
  })

  it('an improvement must be recorded in the baseline of the same PR', () => {
    const base = baselineOf(results())
    const better = results({ tokensToGold: 10_000, hit5: 0.9 })
    const stale = evaluate({ results: better, baseline: base, baseBaseline: base })
    assert.equal(stale.ok, false)
    assert.match(stale.failures.join('\n'), /stale baseline, Elara hit5 is better/)
    assert.match(stale.failures.join('\n'), /stale baseline, Elara tokensToGold is better/)
    const recorded = evaluate({ results: better, baseline: baselineOf(better), baseBaseline: base })
    assert.deepEqual(recorded.failures, [])
  })

  it('a changed question set or policy config needs a regenerated entry', () => {
    const report = evaluate({ results: results({}, { fingerprint: 'fp2' }), baseline: baselineOf(results()) })
    assert.match(report.failures.join('\n'), /fingerprint fp1 != run fp2/)
    // With the entry regenerated, the base (other fingerprint) is not used for regressions.
    const r = results({ hit5: 0.1 }, { fingerprint: 'fp2' })
    const ok = evaluate({ results: r, baseline: baselineOf(r), baseBaseline: baselineOf(results()) })
    assert.deepEqual(ok.failures, [])
    assert.match(ok.notes.join('\n'), /another fingerprint/)
  })

  it('fails on a changed index outcome, a suite without entry, and a missing run', () => {
    const base = baselineOf(results())
    assert.match(evaluate({ results: results({}, { outcome: 'stalled' }), baseline: base }).failures.join('\n'), /index outcome "stalled"/)
    assert.match(evaluate({ results: results({}, { suites: ['s', 't'] }), baseline: base }).failures.join('\n'), /t: no entry/)
    const missing = { ...results(), selected: ['s', 'u'] }
    assert.match(evaluate({ results: missing, baseline: base }).failures.join('\n'), /u: selected but no results/)
    assert.match(evaluate({ results: null, baseline: base }).failures.join('\n'), /wrote no bench-results/)
  })

  it('suites not selected in this run are not judged', () => {
    const both = baselineOf(results({}, { suites: ['s', 't'] }))
    assert.deepEqual(evaluate({ results: results(), baseline: both }).failures, [])
  })
})

describe('toBaseline', () => {
  it('keeps entries of suites the run did not cover and records per-question ranks', () => {
    const first = toBaseline(results({}, { suites: ['s', 't'] }))
    const next = toBaseline(results({ hit5: 0.9 }), first)
    assert.deepEqual(Object.keys(next.suites), ['s', 't'])
    assert.equal(next.suites.s.elara.hit5, 0.9)
    assert.equal(next.suites.t.elara.hit5, 0.6)
    assert.deepEqual(next.suites.s.perQuestion.Q1, { elara: [1, 500], grep: [2, 300] })
    assert.equal(next.suites.s.index, 'complete')
  })
})

describe('render and compare', () => {
  it('prints the delta table with Elara, the delta and grep', () => {
    const base = baselineOf(results())
    const r = results({ tokensToGold: 30_000 })
    const md = render(evaluate({ results: r, baseline: base }), r)
    assert.match(md, /\*\*Fail\.\*\*/)
    assert.match(md, /\| tokensToGold \| 20000 \| 30000 \| \+10000 \(worse\) \| 9000 \| regression \|/)
    assert.match(md, /\| hit5 \| 0\.6 \| 0\.6 \| 0 \| 0\.8 \| ok \|/)
  })

  it('compare lists metric deltas and changed questions between two runs', () => {
    const a = results()
    const b = results({ mrr: 0.4 })
    b.suites.s.perQuestion[0].elara.rank = 3
    const md = compare(a, b)
    assert.match(md, /\| mrr \| 0\.5 \| 0\.4 \| -0\.1 \(worse\)/)
    assert.match(md, /Q1: rank 1 -> 3/)
  })
})
