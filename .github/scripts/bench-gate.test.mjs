// Unit tests for bench-gate.mjs (#570).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { combine, compare, evaluate, movement, overrideReason, render, toBaseline, TOLERANCE } from './bench-gate.mjs'

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
  tokensToGoldReached: 4_000,
  callsToGold: 6,
  linePrecision: 0.01,
  lineRecall: 0.5,
  tokens: 15_000,
  calls: 5,
  msMedian: 900,
  ...over,
})

/** One instance's results.json. */
function instance(elara = {}, { fingerprint = 'fp1', outcome = 'complete', suites = ['s'], rank = 1 } = {}) {
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
          paired: { questions: 10, elara: 3_000, grep: 1_000 },
          perQuestion: [{ id: 'Q1', elara: { rank, tokensToGold: 500 }, grep: { rank: 2, tokensToGold: 300 } }],
        },
      ]),
    ),
  }
}

/** A combined run of three identical instances. */
const run = (elara = {}, opts = {}) => combine([instance(elara, opts), instance(elara, opts), instance(elara, opts)])
const baselineOf = (r) => toBaseline(r)
const pr = (labels = [], body = '') => ({ labels, body })
const failures = (report) => report.failures.join('\n')

describe('movement', () => {
  it('hit@5 tolerates the configured number of questions, after 4-decimal rounding', () => {
    const tol = TOLERANCE.hit5Questions / 20
    assert.equal(movement('hit5', 0.6, 0.6 - tol, 20), 'same')
    assert.equal(movement('hit5', 0.6, 0.6 - tol - 0.05, 20), 'worse')
    assert.equal(movement('hit5', 0.6, 0.6 + tol + 0.05, 20), 'better')
    // 28/29 -> 26/29 as written by round4 is two questions: within tolerance; three is not.
    assert.equal(movement('hit5', 0.9655, 0.8966, 29), 'same')
    assert.equal(movement('hit5', 0.9655, 0.8621, 29), 'worse')
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

describe('combine', () => {
  it('takes the per-metric median of the instances; a miss counts as worst', () => {
    const c = combine([
      instance({ hit5: 0.5, tokensToGold: 30_000 }, { rank: 6 }),
      instance({ hit5: 0.6, tokensToGold: 20_000 }, { rank: 3 }),
      instance({ hit5: 0.7, tokensToGold: 10_000 }, { rank: null }),
    ])
    const s = c.suites.s
    assert.equal(s.aggregate.elara.hit5, 0.6)
    assert.equal(s.aggregate.elara.tokensToGold, 20_000)
    assert.equal(s.perQuestion[0].elara.rank, 6) // ranks 3, 6, miss -> 6
    assert.deepEqual(s.instances.map((i) => i.hit5), [0.5, 0.6, 0.7])
    assert.equal(c.instances, 3)
    const misses = combine([instance({}, { rank: null }), instance({}, { rank: null }), instance({}, { rank: 2 })])
    assert.equal(misses.suites.s.perQuestion[0].elara.rank, null)
  })

  it('refuses instances that measured different things', () => {
    assert.throws(() => combine([instance(), instance({}, { fingerprint: 'fp2' })]), /disagree on the fingerprint/)
  })

  it('reports a mixed index outcome', () => {
    const c = combine([instance(), instance({}, { outcome: 'stalled' }), instance()])
    assert.equal(c.suites.s.index.outcome, 'complete/stalled')
  })
})

describe('overrideReason', () => {
  const o = { label: 'bench-suite-change', line: 'Bench-suite-change' }
  it('needs the label and a reason line', () => {
    assert.equal(overrideReason(pr(['bench-suite-change'], 'Bench-suite-change: keywords now come from the question'), o), 'keywords now come from the question')
    assert.equal(overrideReason(pr([], 'Bench-suite-change: keywords now come from the question'), o), null)
    assert.equal(overrideReason(pr(['bench-suite-change'], ''), o), null)
    assert.equal(overrideReason(pr(['bench-suite-change'], 'Bench-suite-change: <why>'), o), null)
    assert.equal(overrideReason(null, o), null)
  })
})

describe('evaluate', () => {
  it('passes a run that matches its baseline', () => {
    const r = run()
    assert.deepEqual(evaluate({ results: r, baseline: baselineOf(r) }).failures, [])
  })

  it('fails a regression of hit@5 or tokens-to-gold', () => {
    const base = baselineOf(run())
    assert.match(failures(evaluate({ results: run({ hit5: 0.4 }), baseline: base })), /regression, Elara hit5 0.6 -> 0.4/)
    assert.match(failures(evaluate({ results: run({ tokensToGold: 30_000 }), baseline: base })), /regression, Elara tokensToGold 20000 -> 30000/)
  })

  it('a PR cannot hide a regression by lowering its own baseline: the base baseline is the reference', () => {
    const base = baselineOf(run())
    const worse = run({ hit5: 0.3 })
    const report = evaluate({ results: worse, baseline: baselineOf(worse), baseBaseline: base, pr: pr() })
    assert.match(failures(report), /regression, Elara hit5 0.6 -> 0.3 \(base baseline/)
  })

  it('an improvement must be recorded in the baseline of the same PR', () => {
    const base = baselineOf(run())
    const better = run({ tokensToGold: 10_000, hit5: 0.9 })
    const stale = evaluate({ results: better, baseline: base, baseBaseline: base, pr: pr() })
    assert.match(failures(stale), /stale baseline, Elara hit5 is better/)
    assert.match(failures(stale), /stale baseline, Elara tokensToGold is better/)
    assert.deepEqual(evaluate({ results: better, baseline: baselineOf(better), baseBaseline: base, pr: pr() }).failures, [])
  })

  it('a changed suite (questions, keywords, config or harness) fails on a PR without the bench-suite-change override', () => {
    // The bypass the first version allowed: change the fingerprint, record a much worse run.
    const base = baselineOf(run())
    const changed = run({ hit5: 0.1, tokensToGold: 60_000 }, { fingerprint: 'fp2' })
    const blocked = evaluate({ results: changed, baseline: baselineOf(changed), baseBaseline: base, pr: pr() })
    assert.equal(blocked.ok, false)
    assert.match(failures(blocked), /suite changed .*fingerprint fp1 on the base, fp2 here/)
    assert.match(failures(blocked), /bench-suite-change/)
    const md = render(blocked, changed)
    assert.match(md, /\| hit5 \| 0\.1 \| 0\.6 \| 0\.1 \|/) // PR baseline, base baseline, run side by side
    const accepted = evaluate({
      results: changed,
      baseline: baselineOf(changed),
      baseBaseline: base,
      pr: pr(['bench-suite-change'], 'Bench-suite-change: question set rewritten for the new corpus'),
    })
    assert.deepEqual(accepted.failures, [])
    assert.match(accepted.notes.join('\n'), /accepted by label `bench-suite-change`/)
  })

  it('the baseline cannot ratchet down: a worse recorded baseline needs bench-baseline-lowered', () => {
    // Each step is within tolerance of the previous one, as in the review's simulation.
    let base = baselineOf(run())
    const one = TOLERANCE.hit5Questions / 20
    const step = run({ hit5: 0.6 - one, tokensToGold: 21_000 })
    const lowered = evaluate({ results: step, baseline: baselineOf(step), baseBaseline: base, pr: pr() })
    assert.equal(lowered.ok, false)
    assert.match(failures(lowered), /lowers hit5 0.6 -> 0.5, tokensToGold 20000 -> 21000 against the base/)
    const ok = evaluate({
      results: step,
      baseline: baselineOf(step),
      baseBaseline: base,
      pr: pr(['bench-baseline-lowered'], 'Bench-baseline-lowered: the reranker trades hit@5 for latency, owner OK'),
    })
    assert.deepEqual(ok.failures, [])
    // Without the label, a PR that leaves baseline.json alone keeps the old bar.
    base = baselineOf(run())
    assert.deepEqual(evaluate({ results: step, baseline: base, baseBaseline: base, pr: pr() }).failures, [])
  })

  it('fails on a changed index outcome, a suite without entry, and missing results', () => {
    const base = baselineOf(run())
    assert.match(failures(evaluate({ results: run({}, { outcome: 'stalled' }), baseline: base })), /index outcome "stalled"/)
    assert.match(failures(evaluate({ results: run({}, { suites: ['s', 't'] }), baseline: base })), /t: no entry/)
    const missing = { ...run(), selected: ['s', 'u'] }
    assert.match(failures(evaluate({ results: missing, baseline: base })), /u: selected but no results/)
    assert.match(failures(evaluate({ results: null, baseline: base })), /no benchmark results/)
  })

  it('suites not selected in this run are not judged', () => {
    const both = baselineOf(run({}, { suites: ['s', 't'] }))
    assert.deepEqual(evaluate({ results: run(), baseline: both }).failures, [])
  })
})

describe('toBaseline', () => {
  it('keeps entries of suites the run did not cover and records per-question ranks', () => {
    const first = toBaseline(run({}, { suites: ['s', 't'] }))
    const next = toBaseline(run({ hit5: 0.9 }), first)
    assert.deepEqual(Object.keys(next.suites), ['s', 't'])
    assert.equal(next.suites.s.elara.hit5, 0.9)
    assert.equal(next.suites.t.elara.hit5, 0.6)
    assert.deepEqual(next.suites.s.perQuestion.Q1, { elara: [1, 500], grep: [2, 300] })
    assert.equal(next.suites.s.instances, 3)
    assert.deepEqual(next.suites.s.paired, { questions: 10, elara: 3_000, grep: 1_000 })
  })
})

describe('render and compare', () => {
  it('prints the delta table with the baseline, Elara, the delta and grep', () => {
    const base = baselineOf(run())
    const r = run({ tokensToGold: 30_000 })
    const md = render(evaluate({ results: r, baseline: base }), r)
    assert.match(md, /\*\*Fail\.\*\*/)
    assert.match(md, /\| tokensToGold \| 20000 \| 30000 \| \+10000 \(worse\) \| 9000 \| regression \|/)
    assert.match(md, /\| hit5 \| 0\.6 \| 0\.6 \| 0 \| 0\.8 \| ok \|/)
    assert.match(md, /median of 3 instances/)
    assert.match(md, /Questions both agents reach: 10; mean tokens-to-gold on those, Elara 3000, grep 1000/)
  })

  it('compare lists metric deltas and changed questions between two runs', () => {
    const a = instance()
    const b = instance({ mrr: 0.4 }, { rank: 3 })
    const md = compare(a, b)
    assert.match(md, /\| mrr \| 0\.5 \| 0\.4 \| -0\.1 \(worse\)/)
    assert.match(md, /Q1: rank 1 -> 3/)
  })
})
