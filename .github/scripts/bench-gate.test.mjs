// Unit tests for bench-gate.mjs (#570).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HOLDOUT, combine, compare, evaluate, missingReport, movement, overrideReason, overview, render, toBaseline, TOLERANCE } from './bench-gate.mjs'

const GATE = fileURLToPath(new URL('./bench-gate.mjs', import.meta.url))

const agg = (over = {}) => ({
  questions: 20,
  hit1: 0.4,
  hit5: 0.6,
  hit10: 0.7,
  exact1: 0.3,
  exact5: 0.5,
  mrr: 0.5,
  ndcg10: 0.5,
  goldReached: 12,
  goldReachedRate: 0.6,
  abstained: 0,
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
function instance(elara = {}, { fingerprint = 'fp1', suiteFingerprint = 'sf1', outcome = 'complete', suites = ['s'], rank = 1 } = {}) {
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
          suiteFingerprint,
          questions: 20,
          index: { outcome, files: 100, symbols: 50, ms: 60_000 },
          aggregate: { elara: agg(elara), grep: agg({ hit5: 0.8, tokensToGold: 9_000 }) },
          paired: { questions: 10, elara: 3_000, grep: 1_000 },
          perQuestion: Array.from({ length: 20 }, (_, i) => ({
            id: `Q${i + 1}`,
            elara: { rank, tokensToGold: i < 12 ? 500 : null },
            grep: { rank: 2, tokensToGold: 300 },
          })),
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
    // 28/29 -> 27/29 as written by round4 is one question: within tolerance; two are not.
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

  it('exact@1 and the gold-reached rate are gated like hit@5: more than one question lost is red (#1058)', () => {
    const base = baselineOf(run())
    // 20 questions: one question is 0.05.
    assert.deepEqual(evaluate({ results: run({ exact1: 0.26, goldReachedRate: 0.56 }), baseline: base }).failures.filter((f) => /regression/.test(f)), [], 'a loss of 2 of 20 at 0.04 each is within one question... of 0.3 and 0.6')
    assert.match(failures(evaluate({ results: run({ exact1: 0.2 }), baseline: base })), /regression, Elara exact1 0.3 -> 0.2 \(baseline; tolerance 1 of 20 questions\)/)
    assert.match(failures(evaluate({ results: run({ goldReachedRate: 0.5 }), baseline: base })), /regression, Elara goldReachedRate 0.6 -> 0.5/)
  })

  it('a reference recorded before a metric existed does not judge it; the PR must record it', () => {
    const old = baselineOf(run())
    for (const entry of Object.values(old.suites)) {
      delete entry.elara.exact1
      delete entry.elara.goldReachedRate
    }
    const r = run({ exact1: 0.1 })
    const stale = evaluate({ results: r, baseline: old, baseBaseline: old, pr: pr() })
    assert.doesNotMatch(failures(stale), /regression/)
    assert.match(failures(stale), /stale baseline, Elara exact1/)
    assert.deepEqual(evaluate({ results: r, baseline: baselineOf(r), baseBaseline: old, pr: pr() }).failures, [])
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
    const lower = Math.round((0.6 - TOLERANCE.hit5Questions / 20) * 1e4) / 1e4
    const step = run({ hit5: lower, tokensToGold: 21_000 })
    const lowered = evaluate({ results: step, baseline: baselineOf(step), baseBaseline: base, pr: pr() })
    assert.equal(lowered.ok, false)
    assert.match(failures(lowered), new RegExp(`lowers hit5 0.6 -> ${lower}, tokensToGold 20000 -> 21000 against the base`))
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

  it('rejects a gold count loss without --require-golds, including an unidentified loss', () => {
    const base = baselineOf(run())
    const lost = run({ goldReached: 11 })
    const report = evaluate({ results: lost, baseline: base, baseBaseline: base, requireGolds: false })
    assert.equal(report.ok, false)
    assert.match(failures(report), /cannot identify every lost question/)
    assert.equal(report.suites[0].verdicts.goldReached, 'regression')
    const none = run({ goldReached: null })
    assert.equal(evaluate({ results: none, baseline: base }).ok, false)
    const more = run({ goldReached: 13 })
    assert.equal(evaluate({ results: more, baseline: baselineOf(more), baseBaseline: base }).ok, true)
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

  it('overview preserves per-suite regression data, passing values and missing-reference values', () => {
    const values = (cell) => (cell.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
    const table = (lines) => new Map(lines.slice(2).map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
      return [cells[0], cells]
    }))
    const base = baselineOf(run({}, { suites: ['s', 't'] }))
    const r = run({ tokensToGold: 30_000, goldReached: 11, mrr: 0.45 }, { suites: ['s', 't'] })
    const report = evaluate({ results: r, baseline: base, baseBaseline: base, pr: pr(), requireGolds: true })
    const rows = overview(report)
    const displayed = table(rows)
    assert.deepEqual([...displayed.keys()], ['s', 't'])
    for (const name of ['s', 't']) {
      const cells = displayed.get(name)
      assert.deepEqual(cells.slice(1, 6).map(values), [[20], [20_000, 30_000], [12, 11], [0.6, 0.6], [0.5, 0.45]])
      const verdicts = new Map(cells[6].split(',').map((part) => part.trim().split(/:\s*/)))
      assert.equal(verdicts.get('tokensToGold'), 'regression')
      assert.equal(verdicts.get('goldReached'), 'regression')
    }
    const ok = run()
    const passing = table(overview(evaluate({ results: ok, baseline: baselineOf(ok) }))).get('s')
    assert.deepEqual(passing.slice(1, 6).map(values), [[20], [20_000, 20_000], [12, 12], [0.6, 0.6], [0.5, 0.5]])
    assert.equal(passing[6], 'ok')
    const missing = table(overview(evaluate({ results: run({}, { suites: ['s', 'u'] }), baseline: baselineOf(run()) }))).get('u')
    assert.deepEqual(missing.slice(1, 6).map(values), [[20], [20_000], [12], [0.6], [0.5]])
    const md = render(report, r)
    const summary = md.indexOf(rows.join('\n'))
    assert.ok(summary >= 0)
    for (const name of displayed.keys()) assert.ok(md.indexOf(`## ${name}:`) > summary)
  })

})

describe('missing results', () => {
  it('names the artifact and stops before evaluating anything', () => {
    const md = missingReport(['bench-runs/bench-results-2/results.json'])
    assert.match(md, /\*\*Fail\.\*\*/)
    assert.match(md, /Missing results: bench-results-2\. The bench job of that instance failed, timed out or was cancelled/)
    assert.match(md, /- bench-results-2: no bench-runs\/bench-results-2\/results\.json/)
    assert.match(missingReport(['x/results.json']), /Missing results: x\/results\.json\./)
  })

  it('the CLI exits 1 with the artifact name when one instance is missing, even if the others would pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-gate-'))
    try {
      const r = run()
      const files = [1, 2, 3].map((n) => join(dir, `bench-results-${n}`, 'results.json'))
      const writeInstance = (f) => {
        mkdirSync(join(f, '..'), { recursive: true })
        writeFileSync(f, JSON.stringify(instance()))
      }
      files.slice(0, 2).forEach(writeInstance)
      const baselineFile = join(dir, 'baseline.json')
      writeFileSync(baselineFile, JSON.stringify(baselineOf(r)))
      const out = join(dir, 'out')
      const res = spawnSync(process.execPath, [GATE, '--results', files.join(','), '--baseline', baselineFile, '--out', out], { encoding: 'utf8' })
      assert.equal(res.status, 1)
      assert.match(res.stdout, /Missing results: bench-results-3\./)
      assert.match(res.stdout, /::error title=bench-gate: missing results::bench-results-3 missing/)
      assert.ok(!/## s: 20 questions/.test(res.stdout), 'nothing evaluated')
      assert.match(readFileSync(join(out, 'gate.md'), 'utf8'), /Missing results: bench-results-3\./)
      // With all three present the same files pass.
      writeInstance(files[2])
      const okRes = spawnSync(process.execPath, [GATE, '--results', files.join(','), '--baseline', baselineFile, '--out', out], { encoding: 'utf8' })
      assert.equal(okRes.status, 0, okRes.stdout)
      assert.match(okRes.stdout, /\*\*Pass\.\*\*/)
      assert.ok(existsSync(join(out, 'gate.md')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the questions that are not exact (#1058)', () => {
  it('the gate summary lists each question whose gold was missed or whose first location is off gold, with the paired ratio', () => {
    const inst = (q) => ({ ...instance(), suites: { s: { ...instance().suites.s, perQuestion: q } } })
    const q = (id, elara) => ({ id, elara: { rank: 1, tokensToGold: 500, exact1: true, abstained: false, located: ['a.ts#L1-L5'], ...elara }, grep: { rank: 1, tokensToGold: 300 } })
    const perQuestion = [q('Q1', {}), q('Q2', { exact1: false, located: ['b.ts#L9-L9'] }), q('Q3', { tokensToGold: null, exact1: false, abstained: true, located: [null] })]
    const r = combine([inst(perQuestion), inst(perQuestion), inst(perQuestion)])
    const md = render(evaluate({ results: r, baseline: baselineOf(r) }), r)
    assert.match(md, /2 of 20 questions not exact/)
    assert.match(md, /\| Q2 \| first location not on gold \| 500 \| b\.ts#L9-L9 \|/)
    assert.match(md, /\| Q3 \| gold not reached \(abstained\) \| - \| - \|/)
    assert.doesNotMatch(md, /\| Q1 \|/)
    assert.match(md, /Elara ÷ grep = 3 /)
  })
})

describe('the held-out suite (#1059)', () => {
  const changedSearch = ['server/src/search/search.ts']
  const baseRun = () => run({}, { suites: ['s', HOLDOUT] })
  const base = () => baselineOf(baseRun())
  // A ranking PR changes the harness fingerprint of every suite; the held-out questions stay the same.
  const moved = (elara = {}) => run(elara, { suites: ['s', HOLDOUT], fingerprint: 'fp2' })

  it('is judged by the base entry across a harness change, and needs no baseline of its own from a ranking PR', () => {
    const ok = evaluate({ results: moved(), baseline: base(), baseBaseline: base(), pr: pr(['bench-suite-change'], 'Bench-suite-change: the harness moved'), changed: changedSearch })
    // `s` carries the suite-change label; the held-out row needs none.
    assert.deepEqual(ok.failures.filter((f) => f.startsWith(HOLDOUT)), [])
    assert.match(ok.suites.find((r) => r.name === HOLDOUT).refLabel, /held out/)
  })

  it('a regression on it is red and no label argues it away', () => {
    const worse = moved({ hit5: 0.3 })
    const report = evaluate({ results: worse, baseline: base(), baseBaseline: base(), pr: pr(['bench-suite-change', 'bench-baseline-lowered'], 'Bench-suite-change: the harness moved\nBench-baseline-lowered: ranking trade'), changed: changedSearch })
    assert.match(failures(report), /holdout: regression, Elara hit5 0.6 -> 0.3 \(base baseline \(held out/)
  })

  it('a ranking PR cannot write or lower its baseline', () => {
    const better = moved({ hit5: 0.9 })
    const own = baselineOf(better)
    const report = evaluate({ results: better, baseline: own, baseBaseline: base(), pr: pr(['bench-suite-change'], 'Bench-suite-change: the harness moved'), changed: changedSearch })
    assert.match(failures(report), /holdout: benchmarks\/baseline.json changes the held-out entry in a PR that touches search, MCP or the Elara policy/)
    // The policy file and the MCP code count too; a PR that touches neither may record it.
    for (const file of ['benchmarks/lib/policies.ts', 'server/src/mcp/response.ts']) {
      assert.match(failures(evaluate({ results: better, baseline: own, baseBaseline: base(), pr: pr(), changed: [file] })), /changes the held-out entry/, file)
    }
    const recorded = run({ hit5: 0.9 }, { suites: ['s', HOLDOUT] })
    const bench = evaluate({ results: recorded, baseline: baselineOf(recorded), baseBaseline: base(), pr: pr(), changed: ['benchmarks/baseline.json'] })
    assert.deepEqual(bench.failures.filter((f) => f.startsWith(HOLDOUT)), [])
  })

  it('other questions or another repository need a PR with no ranking change', () => {
    const other = run({}, { suites: ['s', HOLDOUT], fingerprint: 'fp2', suiteFingerprint: 'sf2' })
    assert.match(failures(evaluate({ results: other, baseline: base(), baseBaseline: base(), pr: pr(), changed: changedSearch })), /held-out questions or repository differ/)
  })

  it('a deleted or renamed suite is not a way out: every suite of the base must run on the all-suites path', () => {
    const gone = run({}, { suites: ['s'] })
    const report = evaluate({ results: gone, baseline: baselineOf(gone), baseBaseline: base(), pr: pr(), requireGolds: true, changed: changedSearch })
    assert.match(failures(report), /holdout: in the base baseline but not in this run/)
    // A tier that runs one suite on purpose (no golds floor) is not asked for the others.
    assert.doesNotMatch(failures(evaluate({ results: gone, baseline: baselineOf(gone), baseBaseline: base(), pr: pr(), changed: ['docs/x.md'] })), /not in this run/)
  })

  it('a tool definition or contract edit does not lock it: only the ladder and the reads do', () => {
    const better = moved({ hit5: 0.9 })
    for (const file of ['server/src/mcp/server.ts', 'server/src/mcp/code-queries.ts', 'server/src/mcp/prompts.ts']) {
      assert.doesNotMatch(failures(evaluate({ results: better, baseline: baselineOf(better), baseBaseline: base(), pr: pr(), changed: [file] })), /changes the held-out entry/, file)
    }
  })

  it('the extraction path, the ladder and a renamed file lock it too, and its report shows numbers only', () => {
    const better = moved({ hit5: 0.9 })
    for (const file of ['server/src/repositories/extraction-queue.ts', 'server/src/text/blocks.ts', 'server/src/notes/note-blocks.ts', 'server/src/config.ts', 'server/src/mcp/response.ts', 'server/src/mcp/read-targets.ts', 'server/src/mcp/session-reads.ts']) {
      assert.match(failures(evaluate({ results: better, baseline: baselineOf(better), baseBaseline: base(), pr: pr(), changed: [file] })), /changes the held-out entry/, file)
    }
    // A file moved out of `server/src/search/` lists both its names (the workflow adds `previous_filename`): the old one locks.
    assert.match(failures(evaluate({ results: better, baseline: baselineOf(better), baseBaseline: base(), pr: pr(), changed: ['src/elsewhere/x.ts', 'server/src/search/x.ts'] })), /changes the held-out entry/)
    const md = render(evaluate({ results: moved(), baseline: base(), baseBaseline: base(), pr: pr(), changed: changedSearch }), moved())
    assert.doesNotMatch(md.split('## holdout')[1] ?? '', /questions changed|not exact/)
  })

  it('without a base entry (the PR that adds the suite) or without a file list it is judged as any suite', () => {
    const added = evaluate({ results: baseRun(), baseline: base(), baseBaseline: baselineOf(run()), pr: pr(), changed: changedSearch })
    assert.deepEqual(added.failures, [])
    const unknown = evaluate({ results: moved(), baseline: base(), baseBaseline: base(), pr: pr(['bench-suite-change'], 'Bench-suite-change: the harness moved'), changed: null })
    assert.match(failures(unknown), /holdout: baseline fingerprint fp1 != run fp2/)
  })
})

describe('gold-loss protection (#1138)', () => {
  const base = () => baselineOf(run())
  const loss = (aggregate = {}, opts = {}) => {
    const r = run(aggregate, opts)
    for (const s of Object.values(r.suites)) s.perQuestion[0].elara.tokensToGold = null
    return r
  }
  const waiver = (ids) => pr(['bench-baseline-lowered'], `Bench-baseline-lowered: owner accepts the lost answers ${ids} for this contract change`)

  it('goldReached has zero movement tolerance without changing the fractional metrics', () => {
    assert.equal(movement('goldReached', 12, 11, 20), 'worse')
    assert.equal(movement('goldReached', 12, 12, 20), 'same')
    assert.equal(movement('goldReached', 12, 13, 20), 'better')
    assert.equal(movement('goldReachedRate', 0.6, 0.55, 20), 'same')
  })

  it('rejects a hidden question loss despite aggregate improvement and GOLDS=false', () => {
    const r = loss({ goldReached: 13 })
    r.suites.s.perQuestion[12].elara.tokensToGold = 500
    r.suites.s.perQuestion[13].elara.tokensToGold = 500
    const report = evaluate({ results: r, baseline: baselineOf(r), baseBaseline: base(), requireGolds: false })
    assert.equal(report.ok, false)
    assert.match(failures(report), /s\/Q1/)
  })

  it('checks both the re-record and actual results before a harness mismatch can skip them', () => {
    const r = loss({ goldReached: 11 }, { fingerprint: 'fp2' })
    const args = { results: r, baseBaseline: base(), pr: pr(['bench-suite-change'], 'Bench-suite-change: the paging contract changed') }
    const reset = evaluate({ ...args, baseline: baselineOf(r) })
    assert.equal(reset.ok, false)
    assert.match(failures(reset), /recorded baseline against base baseline/)
    assert.match(failures(reset), /s\/Q1/)
    const mismatch = evaluate({ ...args, baseline: base() })
    assert.match(failures(mismatch), /s\/Q1/)
    assert.match(failures(mismatch), /baseline fingerprint/)
  })

  it('also protects newly recorded golds when the actual run falls back to the older count', () => {
    const improved = run({ goldReached: 13 })
    improved.suites.s.perQuestion[12].elara.tokensToGold = 500
    const report = evaluate({ results: run(), baseline: baselineOf(improved), baseBaseline: base() })
    assert.equal(report.ok, false)
    assert.match(failures(report), /s\/Q13/)
  })

  it('checks changed baseline entries outside the selected suite, including a deleted suite', () => {
    const before = baselineOf(run({}, { suites: ['s', 't'] }))
    const own = structuredClone(before)
    own.suites.t.perQuestion.Q1.elara[1] = null
    assert.match(failures(evaluate({ results: run(), baseline: own, baseBaseline: before })), /t\/Q1/)
    delete own.suites.t
    assert.match(failures(evaluate({ results: run(), baseline: own, baseBaseline: before })), /t\/Q1/)
  })

  it('rejects removal and renaming of a previously reached question', () => {
    for (const rename of [false, true]) {
      const r = run()
      if (rename) r.suites.s.perQuestion[0].id = 'renamed'
      else r.suites.s.perQuestion.shift()
      assert.match(failures(evaluate({ results: r, baseline: baselineOf(r), baseBaseline: base() })), /s\/Q1/)
    }
  })

  it('requires the label and every exact qualified ID; generic, partial and substring reasons do not approve', () => {
    const r = loss({ goldReached: 11, goldReachedRate: 0.55 })
    r.suites.s.perQuestion[1].elara.tokensToGold = null
    r.suites.s.perQuestion[12].elara.tokensToGold = 500 // A gain does not excuse the two named losses.
    const args = { results: r, baseline: baselineOf(r), baseBaseline: base() }
    for (const approval of [
      pr([], 'Bench-baseline-lowered: owner accepts s/Q1 s/Q2'),
      pr(['bench-baseline-lowered'], ''),
      waiver('the suite regression'), waiver('Q1 Q2'), waiver('s/Q1'),
      waiver('s/Q10 s/Q20'), waiver('s/Q1/other s/Q2'), waiver('other/Q1 other/Q2'),
    ]) assert.equal(evaluate({ ...args, pr: approval }).ok, false)
    const accepted = evaluate({ ...args, pr: waiver('`s/Q1`, `s/Q2`') })
    assert.equal(accepted.ok, true, failures(accepted))
    assert.match(accepted.notes.join('\n'), /owner exception/)
  })

  it('cannot waive a count drop whose question IDs are unprovable or missing provenance', () => {
    const r = loss({ goldReached: 10 }) // Only one identified loss, but the count lost two.
    assert.equal(evaluate({ results: r, baseline: baselineOf(r), baseBaseline: base(), pr: waiver('s/Q1') }).ok, false)
    const before = base()
    delete before.suites.s.perQuestion
    assert.equal(evaluate({ results: run(), baseline: baselineOf(run()), baseBaseline: before, pr: waiver('s/Q1') }).ok, false)
    const incomplete = run()
    delete incomplete.suites.s.perQuestion[0].elara.tokensToGold
    assert.equal(evaluate({ results: incomplete, baseline: baselineOf(run()), baseBaseline: base(), pr: waiver('s/Q1') }).ok, false)
  })

  it('never waives a held-out ranking loss, even with its exact ID', () => {
    const r = loss({ goldReached: 11 }, { suites: [HOLDOUT] })
    const before = baselineOf(run({}, { suites: [HOLDOUT] }))
    const report = evaluate({ results: r, baseline: before, baseBaseline: before, pr: waiver('holdout/Q1'), changed: ['server/src/search/search.ts'] })
    assert.equal(report.ok, false)
    assert.match(failures(report), /Held-out ranking losses cannot be waived/)
  })

  it('keeps unchanged, improved, new-suite and legacy-new-metric controls legitimate', () => {
    const before = base()
    assert.equal(evaluate({ results: run(), baseline: before, baseBaseline: before }).ok, true)
    const improved = run({ goldReached: 13 })
    assert.equal(evaluate({ results: improved, baseline: baselineOf(improved), baseBaseline: before }).ok, true)
    assert.equal(evaluate({ results: run(), baseline: before }).ok, true)
    assert.equal(evaluate({ results: run(), baseline: before, baseBaseline: { suites: {} } }).ok, true)
    delete before.suites.s.elara.exact1
    delete before.suites.s.elara.goldReachedRate
    assert.equal(evaluate({ results: run(), baseline: baselineOf(run()), baseBaseline: before }).ok, true)
  })

  it('the CLI combines all three measurements and fails a hidden gold loss without a flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-gold-loss-'))
    try {
      const files = [1, 2, 3].map((n) => {
        const inst = instance({ goldReached: n === 3 ? 14 : 13 })
        if (n !== 3) inst.suites.s.perQuestion[0].elara.tokensToGold = null
        inst.suites.s.perQuestion[12].elara.tokensToGold = 500
        inst.suites.s.perQuestion[13].elara.tokensToGold = 500
        const file = join(dir, `${n}.json`)
        writeFileSync(file, JSON.stringify(inst))
        return file
      })
      const current = combine(files.map((f) => JSON.parse(readFileSync(f, 'utf8'))))
      assert.equal(current.suites.s.perQuestion[0].elara.tokensToGold, null)
      assert.equal(current.suites.s.aggregate.elara.goldReached, 13)
      const baselineFile = join(dir, 'baseline.json')
      const baseFile = join(dir, 'base.json')
      const prFile = join(dir, 'pr.json')
      writeFileSync(baselineFile, JSON.stringify(baselineOf(current)))
      writeFileSync(baseFile, JSON.stringify(base()))
      const args = [GATE, '--results', files.join(','), '--baseline', baselineFile, '--base-baseline', baseFile, '--out', join(dir, 'out')]
      const rejected = spawnSync(process.execPath, args, { encoding: 'utf8' })
      assert.equal(rejected.status, 1, rejected.stdout)
      assert.match(rejected.stdout, /s\/Q1/)
      writeFileSync(prFile, JSON.stringify(waiver('s/Q1')))
      const approved = spawnSync(process.execPath, [...args, '--pr', prFile], { encoding: 'utf8' })
      assert.equal(approved.status, 0, approved.stdout)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
