// Premise benchmark gate (#570). Combines the benchmark instances of one
// workflow run (bench-results-<n>/results.json, written by benchmarks/run.ts
// on separate lab instances) into their per-metric median, compares that
// with the committed baseline benchmarks/baseline.json, and fails the job
// when
//   0. an instance's results.json is missing: the job stops right there with
//      the artifact's name (the bench job failed, timed out or was
//      cancelled), before any evaluation;
//   1. a selected suite has no results, or the instances disagree on a
//      suite's fingerprint (harness failure);
//   2. regression: Elara's hit@5, exact@1, gold-reached rate or mean
//      tokens-to-gold is worse than the reference by more than TOLERANCE
//      (#1058). On a pull request the reference is the BASE commit's
//      baseline; a metric the reference does not have yet is not judged;
//   3. suite changed: on a pull request the run's fingerprint (questions,
//      keywords, policy config and the harness source in benchmarks/) differs
//      from the base baseline's, so the base cannot judge it. Passing needs
//      the label `bench-suite-change` plus a `Bench-suite-change: <why>` line
//      in the PR body; the summary shows both tables for the reviewer;
//   4. baseline lowered: the PR's baseline.json records a worse hit@5 or
//      tokens-to-gold than the base commit's (same fingerprint). Never
//      silent: needs the label `bench-baseline-lowered` plus a
//      `Bench-baseline-lowered: <why>` line. Without this rule the baseline
//      could slide down one tolerance per PR;
//   5. stale baseline: the run does not match the PR's baseline within the
//      tolerance in either direction (an improvement must be recorded in the
//      same PR), the fingerprint or the index outcome differs, or a selected
//      suite has no entry;
//   6. golds lost: fewer goldReached or a previously reached question
//      missed/removed, in the run or any changed baseline entry, even across
//      harness changes. Exceptions name every suite/question in the owner's
//      bench-baseline-lowered reason; held-out ranking losses cannot be waived.
// It writes a per-suite overview (tokens-to-gold, golds, hit@5, MRR) and the
// delta tables to the job summary and to <out>/gate.md.
//
// Tolerances: measured noise plus a margin (benchmarks/README.md, "Noise").
// They live here, not in the baseline, and on pull requests the workflow
// runs the base commit's copy of this file, so a PR does not change the
// rules it is judged by. (The workflow file itself comes from the PR. The
// check is required on dev and prod (#574), so it cannot be dropped, but an
// edited job can still pass: reviewers read changes to the workflow.)
//
// Plain Node, no dependencies, one file (it is copied alone to a temp dir).
//
//   node .github/scripts/bench-gate.mjs --results a/results.json,b/results.json,c/results.json \
//     [--baseline benchmarks/baseline.json] [--base-baseline <file>] [--pr <pulls API JSON>] [--require-golds] [--out bench-results]
//   node .github/scripts/bench-gate.mjs --write-baseline a/results.json,b/results.json,c/results.json [--baseline benchmarks/baseline.json]
//   node .github/scripts/bench-gate.mjs --compare a/results.json b/results.json

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * hit5Questions: questions whose hit@5, exact@1 or gold-reached rate may
 * flip before a change counts (tolerance = hit5Questions / questions of the
 * suite; more than one question lost is red).
 * tokensRelative: relative change of mean tokens-to-gold that counts.
 */
export const TOLERANCE = { hit5Questions: 1, tokensRelative: 0.1 }

/** Metrics the gate acts on (Elara policy); the rest are reported only. */
export const GATED = ['hit5', 'exact1', 'goldReachedRate', 'tokensToGold', 'goldReached']

/** Gated metrics that are a fraction of the suite's questions. */
const FRACTION_METRICS = new Set(['hit5', 'exact1', 'goldReachedRate'])

/**
 * The held-out suite (#1059): its questions are never used to tune ranking constants. A PR that touches one of
 * RANKING_PATHS cannot write or lower its baseline and cannot argue a regression away with a label.
 */
export const HOLDOUT = 'holdout'
export const RANKING_PATHS = [
  /^server\/src\/search\//,
  /^server\/src\/mcp\/(response|read-targets|session-reads)\.ts$/,
  // What decides an agent's answer besides search and MCP: the extraction path (lab-plan.mjs `BENCH_ALL`).
  /^server\/src\/repositories\/(extraction|code-blocks|code-edge|outline|import-resolution|language)[^/]*$/,
  /^server\/src\/text\/(blocks|lines|targets)\.ts$/,
  /^server\/src\/notes\/note-blocks\.ts$/,
  /^server\/src\/config\.ts$/,
  /^benchmarks\/lib\/policies\.ts$/,
]

/** Owner overrides: label + PR body line with the reason. */
export const OVERRIDES = {
  suiteChange: { label: 'bench-suite-change', line: 'Bench-suite-change' },
  baselineLowered: { label: 'bench-baseline-lowered', line: 'Bench-baseline-lowered' },
}

/** Aggregate fields, in table order; higher is better unless listed in LOWER_IS_BETTER. */
export const METRICS = [
  'hit1',
  'hit5',
  'hit10',
  'exact1',
  'exact5',
  'mrr',
  'ndcg10',
  'goldReached',
  'goldReachedRate',
  'abstained',
  'routed',
  'exact1Routed',
  'tokensToGold',
  'tokensToGoldMedian',
  'tokensToGoldReached',
  'callsToGold',
  'linePrecision',
  'lineRecall',
  'tokens',
  'calls',
  'msMedian',
]
const LOWER_IS_BETTER = new Set(['tokensToGold', 'tokensToGoldMedian', 'tokensToGoldReached', 'callsToGold', 'tokens', 'calls', 'msMedian'])

/** Median of an odd count; the lower middle of an even one. null counts as worst (a miss). */
function med(values, lowerIsBetter = true) {
  const worst = lowerIsBetter ? Infinity : -Infinity
  const s = values.map((v) => v ?? worst).sort((a, b) => a - b)
  const v = s[Math.floor((s.length - 1) / 2)]
  return v === Infinity || v === -Infinity || v === undefined ? null : v
}

/**
 * The per-metric median of several instances of the same run (same
 * suites, same commit). Throws when they disagree on a suite's fingerprint.
 */
export function combine(list) {
  const [first] = list
  const suites = {}
  for (const name of first.selected) {
    const runs = list.map((r) => r.suites[name]).filter(Boolean)
    if (runs.length !== list.length) continue
    const fps = new Set(runs.map((s) => s.fingerprint))
    if (fps.size !== 1) throw new Error(`${name}: instances disagree on the fingerprint (${[...fps].join(', ')})`)
    const outcomes = [...new Set(runs.map((s) => s.index.outcome))]
    const agg = (policy) =>
      Object.fromEntries(Object.keys(runs[0].aggregate[policy]).map((m) => [m, med(runs.map((s) => s.aggregate[policy][m]), LOWER_IS_BETTER.has(m))]))
    const perQuestion = runs[0].perQuestion.map((q, i) => {
      const side = (policy) => ({
        rank: med(runs.map((s) => s.perQuestion[i][policy].rank)),
        tokensToGold: med(runs.map((s) => s.perQuestion[i][policy].tokensToGold)),
        // Whether the first returned location overlapped gold and whether the search abstained, in the median instance (#1058); the first returned location of the first instance.
        exact1: med(runs.map((s) => (s.perQuestion[i][policy].exact1 ? 1 : 0)), false),
        abstained: med(runs.map((s) => (s.perQuestion[i][policy].abstained ? 1 : 0)), false),
        located: runs[0].perQuestion[i][policy].located?.[0] ?? null,
      })
      return { id: q.id, elara: side('elara'), grep: side('grep') }
    })
    suites[name] = {
      fingerprint: runs[0].fingerprint,
      suiteFingerprint: runs[0].suiteFingerprint,
      questions: runs[0].questions,
      index: {
        outcome: outcomes.length === 1 ? outcomes[0] : outcomes.join('/'),
        files: med(runs.map((s) => s.index.files)),
        symbols: med(runs.map((s) => s.index.symbols)),
        ms: med(runs.map((s) => s.index.ms)),
      },
      aggregate: { elara: agg('elara'), grep: agg('grep') },
      paired: runs[0].paired && {
        questions: med(runs.map((s) => s.paired.questions), false),
        elara: med(runs.map((s) => s.paired.elara)),
        grep: med(runs.map((s) => s.paired.grep)),
      },
      instances: runs.map((s) => ({ hit5: s.aggregate.elara.hit5, tokensToGold: s.aggregate.elara.tokensToGold })),
      perQuestion,
    }
  }
  return {
    commit: first.commit,
    runUrls: [...new Set(list.map((r) => r.runUrl).filter(Boolean))],
    instances: list.length,
    selected: first.selected,
    missCost: first.missCost,
    suites,
  }
}

/** Baseline entries of a combined run: aggregates plus each question's (rank, tokens-to-gold). */
export function toBaseline(combined, previous = { suites: {} }) {
  const suites = { ...previous.suites }
  for (const [name, s] of Object.entries(combined.suites)) {
    suites[name] = {
      fingerprint: s.fingerprint,
      suiteFingerprint: s.suiteFingerprint,
      commit: combined.commit,
      runs: combined.runUrls,
      instances: combined.instances,
      questions: s.questions,
      index: s.index.outcome,
      elara: s.aggregate.elara,
      grep: s.aggregate.grep,
      paired: s.paired,
      perQuestion: Object.fromEntries(
        s.perQuestion.map((q) => [q.id, { elara: [q.elara.rank, q.elara.tokensToGold], grep: [q.grep.rank, q.grep.tokensToGold] }]),
      ),
    }
  }
  return {
    note: 'Premise benchmark baseline: per-metric median of the instances of one CI run. Generated by `node .github/scripts/bench-gate.mjs --write-baseline <results.json,...>`; never edit numbers by hand. Method: benchmarks/README.md.',
    suites: Object.fromEntries(Object.entries(suites).sort(([a], [b]) => a.localeCompare(b))),
  }
}

/**
 * How a gated metric moved from `ref` to `cur`: 'worse', 'better' or 'same'
 * (within tolerance). hit5 is a fraction of `questions`.
 */
export function movement(metric, ref, cur, questions) {
  if (metric === 'goldReached') return cur < ref ? 'worse' : cur > ref ? 'better' : 'same'
  if (FRACTION_METRICS.has(metric)) {
    // Aggregates are rounded to 4 decimals (round4 in benchmarks/lib/metrics.ts): allow that rounding.
    const tol = TOLERANCE.hit5Questions / questions + 1e-4
    return cur < ref - tol ? 'worse' : cur > ref + tol ? 'better' : 'same'
  }
  if (metric === 'tokensToGold') {
    const tol = ref * TOLERANCE.tokensRelative
    return cur > ref + tol ? 'worse' : cur < ref - tol ? 'better' : 'same'
  }
  throw new Error(`metric ${metric} is not gated`)
}

/** The reason given for an override, or null: the label must be on the PR and the body must carry `<Line>: <reason>` (10+ characters, no placeholder). */
export function overrideReason(pr, override) {
  if (!pr?.labels?.includes(override.label)) return null
  for (const line of (pr.body ?? '').split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:[-*]\\s+)?\\**${override.line}:?\\**:?(.*)$`, 'i').exec(line)
    const reason = m?.[1].replace(/<[^>]*>/g, ' ').trim()
    if (reason && reason.length >= 10) return reason
  }
  return null
}

/** Gold evidence survives a harness reset; never infer unknown question losses from a count. */
function checkGolds(name, reference, current, source, locked, pr, failures, notes) {
  if (!reference) return 'ok' // New suite/bootstrap: no prior gold evidence.
  const was = reference.elara.goldReached
  const cur = current?.aggregate ? current.aggregate.elara.goldReached : current?.elara?.goldReached
  const before = reference.perQuestion
  const after = Array.isArray(current?.perQuestion)
    ? Object.fromEntries(current.perQuestion.map((q) => [q.id, { elara: [q.elara.rank, q.elara.tokensToGold] }]))
    : current?.perQuestion
  const lost = []
  let unknown = !before || Object.keys(before).length !== reference.questions || (current && !after)
  for (const [id, q] of Object.entries(before ?? {})) {
    const tokens = q.elara?.[1]
    if (tokens !== null && !Number.isFinite(tokens)) unknown = true
    if (!Number.isFinite(tokens)) continue
    const next = after?.[id]
    if (!next || next.elara?.[1] === null) lost.push(`${name}/${id}`)
    else if (!Number.isFinite(next.elara?.[1])) unknown = true
  }
  const countLost = was !== undefined && (!Number.isFinite(cur) || cur < was)
  if (countLost && (!Number.isFinite(cur) || was - cur > lost.length)) unknown = true
  if (unknown) {
    failures.push(`${name}: gold evidence missing or incomplete (${source}); cannot identify every lost question or approve an unknown loss; known lost questions: ${lost.join(', ') || 'unknown'}`)
    return 'regression'
  }
  if (!countLost && lost.length === 0) return 'ok'
  const what = `golds lost, Elara goldReached ${was ?? '-'} -> ${cur ?? '-'} of ${reference.questions} (${source}); previously reached questions missed or removed: ${lost.join(', ') || 'unknown'}`
  const reason = overrideReason(pr, OVERRIDES.baselineLowered)
  const named = new Set(reason?.split(/[\s,;:()[\]{}'"`]+/) ?? [])
  if (!locked && reason && lost.length > 0 && lost.every((id) => named.has(id))) {
    notes.push(`${name}: ${what}; owner exception by label \`${OVERRIDES.baselineLowered.label}\`: "${reason}"`)
    return 'approved'
  }
  failures.push(`${name}: ${what}. ${locked ? 'Held-out ranking losses cannot be waived.' : 'Owner approval needs bench-baseline-lowered and a Bench-baseline-lowered reason naming every exact suite/question ID.'}`)
  return 'regression'
}

/**
 * The verdict. `results` = combined instances (combine()), `baseline` = the
 * PR's (or the branch's) baseline file, `baseBaseline` = the base commit's
 * on a pull request (null otherwise), `pr` = { labels, body } on a pull
 * request, `requireGolds` = require every base suite to run; gold count and
 * per-question losses are protected on every path, independently of this flag.
 */
export function evaluate({ results, baseline, baseBaseline = null, pr = null, requireGolds = false, changed = null }) {
  const rankingChange = changed !== null && changed.some((f) => RANKING_PATHS.some((re) => re.test(f)))
  const failures = []
  const notes = []
  const suites = []
  if (!results) return { ok: false, failures: ['no benchmark results (harness failure: see the bench jobs)'], notes, suites, requireGolds }
  // The all-suites path runs every suite of the base: one missing (deleted, renamed) is not judged by the loop below, so it fails here (#1059).
  if (requireGolds && baseBaseline?.suites) {
    for (const name of Object.keys(baseBaseline.suites)) {
      if (!results.selected.includes(name)) failures.push(`${name}: in the base baseline but not in this run (a suite deleted or renamed is not judged: the all-suites path runs every one)`)
    }
  }
  // Check every re-record, including suites absent from this run, before fingerprint guards.
  for (const [name, base] of Object.entries(baseBaseline?.suites ?? {})) {
    const own = baseline?.suites?.[name]
    if (JSON.stringify(own) === JSON.stringify(base)) continue
    const locked = name === HOLDOUT && rankingChange
    if (locked) failures.push(`${name}: benchmarks/baseline.json changes the held-out entry in a PR that touches search, MCP or the Elara policy. A ranking change never writes its own held-out baseline: record it in a separate \`bench:\` PR that only updates the baseline.`)
    checkGolds(name, base, own, 'recorded baseline against base baseline', locked, pr, failures, notes)
  }
  for (const name of results.selected) {
    const run = results.suites[name]
    if (!run) {
      failures.push(`${name}: selected but no results from every instance`)
      continue
    }
    const own = baseline?.suites?.[name]
    const base = baseBaseline?.suites?.[name]
    const row = { name, run, own, base, verdicts: {} }
    suites.push(row)
    const locked = name === HOLDOUT && rankingChange && base !== undefined
    row.verdicts.goldReached = checkGolds(name, base ?? own, run, base ? 'base baseline' : 'baseline', locked, pr, failures, notes)
    if (base && own && JSON.stringify(own) !== JSON.stringify(base)) {
      const ownGolds = checkGolds(name, own, run, 'recorded baseline', locked, pr, failures, notes)
      if (ownGolds !== 'ok') row.verdicts.goldReached = ownGolds
    }
    if (!own) {
      failures.push(`${name}: no entry in benchmarks/baseline.json; add it from this run (--write-baseline)`)
      continue
    }
    // The held-out baseline is frozen against a PR that changes ranking code (#1059): it may not be written or lowered, and the run
    // is judged by the base's entry whatever the harness fingerprint says, as long as the questions and the repository are the same.
    if (locked) {
      if (base.suiteFingerprint === undefined || base.suiteFingerprint !== run.suiteFingerprint) {
        failures.push(`${name}: the held-out questions or repository differ from the base's (suite fingerprint ${base.suiteFingerprint ?? 'missing'} vs ${run.suiteFingerprint ?? 'missing'}), so the base cannot judge this run; change them in a PR that touches no ranking code`)
        continue
      }
    } else if (own.fingerprint !== run.fingerprint) {
      failures.push(`${name}: baseline fingerprint ${own.fingerprint} != run ${run.fingerprint} (questions, keywords, policy config or harness code changed); regenerate the entry from this run`)
      continue
    }
    if (own.index !== run.index.outcome) {
      failures.push(`${name}: index outcome "${run.index.outcome}" but the baseline was measured on "${own.index}"`)
    }
    // Regression reference: the base commit's baseline. A changed suite cannot be judged by it.
    let ref = own
    let refLabel = 'baseline'
    if (locked || (base && base.fingerprint === run.fingerprint)) {
      ref = base
      refLabel = locked ? 'base baseline (held out: no label argues a regression away)' : 'base baseline'
    } else if (base) {
      const reason = overrideReason(pr, OVERRIDES.suiteChange)
      const what = `suite changed (questions, keywords, policy config or harness code: fingerprint ${base.fingerprint} on the base, ${run.fingerprint} here), so the base baseline cannot judge this run`
      if (reason) notes.push(`${name}: ${what}; accepted by label \`${OVERRIDES.suiteChange.label}\`: "${reason}". Compare the two tables below.`)
      else failures.push(`${name}: ${what}. Add the label \`${OVERRIDES.suiteChange.label}\` and a "${OVERRIDES.suiteChange.line}: <why>" line to the PR body, then re-run the bench-gate job. Both tables are below.`)
    }
    row.ref = ref
    row.refLabel = refLabel
    for (const metric of GATED) {
      if (metric === 'goldReached') continue // Count and question evidence were checked before fingerprint guards.
      const cur = run.aggregate.elara[metric]
      // A baseline recorded before a metric existed (#1058) has no number to judge it by: the run is stale until it records one, a regression is not yet defined.
      const vsRef = cur === undefined || ref.elara[metric] === undefined ? 'same' : movement(metric, ref.elara[metric], cur, run.questions)
      const vsOwn = cur === undefined ? 'same' : own.elara[metric] === undefined ? 'better' : movement(metric, own.elara[metric], cur, run.questions)
      row.verdicts[metric] = vsRef === 'worse' ? 'regression' : vsOwn !== 'same' && !locked ? 'stale' : 'ok'
      if (vsRef === 'worse') {
        failures.push(`${name}: regression, Elara ${metric} ${ref.elara[metric]} -> ${cur} (${refLabel}; tolerance ${describeTolerance(metric, run.questions)})`)
      } else if (vsOwn !== 'same' && !locked) {
        failures.push(`${name}: stale baseline, Elara ${metric} is ${vsOwn} than benchmarks/baseline.json (${own.elara[metric]} -> ${cur}); record this run with --write-baseline in this PR`)
      }
    }
    // The recorded bar may only go up unless an owner says otherwise.
    if (base && base.fingerprint === own.fingerprint) {
      const lowered = GATED.filter((m) => m !== 'goldReached' && base.elara[m] !== undefined && (LOWER_IS_BETTER.has(m) ? own.elara[m] > base.elara[m] : own.elara[m] < base.elara[m]))
      if (lowered.length > 0) {
        const what = `benchmarks/baseline.json lowers ${lowered.map((m) => `${m} ${base.elara[m]} -> ${own.elara[m]}`).join(', ')} against the base`
        const reason = overrideReason(pr, OVERRIDES.baselineLowered)
        if (reason) notes.push(`${name}: ${what}; accepted by label \`${OVERRIDES.baselineLowered.label}\`: "${reason}"`)
        else failures.push(`${name}: ${what}. A worse baseline is an owner decision: add the label \`${OVERRIDES.baselineLowered.label}\` and a "${OVERRIDES.baselineLowered.line}: <why>" line to the PR body, then re-run the bench-gate job.`)
      }
    }
  }
  return { ok: failures.length === 0, failures, notes, suites, requireGolds }
}

function describeTolerance(metric, questions) {
  return FRACTION_METRICS.has(metric) ? `${TOLERANCE.hit5Questions} of ${questions} questions` : `${TOLERANCE.tokensRelative * 100} %`
}

function fmt(v) {
  if (v === undefined || v === null) return '-'
  return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

function delta(metric, ref, cur) {
  if (ref === undefined || ref === null || cur === undefined || cur === null) return '-'
  const d = cur - ref
  if (Math.abs(d) < 1e-9) return '0'
  const better = LOWER_IS_BETTER.has(metric) ? d < 0 : d > 0
  return `${d > 0 ? '+' : ''}${fmt(Math.round(d * 10_000) / 10_000)} ${better ? '(better)' : '(worse)'}`
}

/** Per-question differences between a baseline entry and a run (Elara rank or tokens-to-gold). */
export function questionChanges(entry, run) {
  if (!entry?.perQuestion) return []
  const out = []
  for (const q of run.perQuestion) {
    const was = entry.perQuestion[q.id]
    if (!was) continue
    const [rank, tokens] = was.elara
    if (rank !== q.elara.rank || tokens !== q.elara.tokensToGold) {
      out.push(`${q.id}: rank ${rank ?? 'miss'} -> ${q.elara.rank ?? 'miss'}, tokens-to-gold ${tokens ?? 'miss'} -> ${q.elara.tokensToGold ?? 'miss'}`)
    }
  }
  return out
}

/** The artifact an instance's results file belongs to (`bench-results-<n>`), or the path. */
const artifactOf = (file) => /bench-results-\d+/.exec(file)?.[0] ?? file

/**
 * The gate's verdict when an instance's results.json is missing: the job
 * stops here, before combining or evaluating anything, and names the
 * artifact so the reader goes straight to that bench job.
 */
export function missingReport(missing) {
  const names = missing.map(artifactOf)
  return [
    '# Premise benchmark gate',
    '',
    '**Fail.**',
    '',
    `Missing results: ${names.join(', ')}. The bench job of that instance failed, timed out or was cancelled before it uploaded results.json: open its log. Nothing was evaluated; the gate needs all instances.`,
    '',
    ...missing.map((f) => `- ${artifactOf(f)}: no ${f}`),
    '',
  ].join('\n')
}

/** One row per suite: the four numbers a reviewer reads first, reference -> run. */
export function overview(report) {
  const pair = (ref, cur) => (ref === undefined || ref === null ? fmt(cur) : `${fmt(ref)} -> ${fmt(cur)}`)
  const md = ['| suite | questions | tokens-to-gold | golds | hit@5 | MRR | gate |', '|---|---|---|---|---|---|---|']
  for (const row of report.suites) {
    const { run } = row
    const ref = (row.ref ?? row.own)?.elara ?? {}
    const cur = run.aggregate.elara
    const verdicts = Object.entries(row.verdicts)
    const bad = verdicts.filter(([, v]) => v !== 'ok').map(([m, v]) => `${m}: ${v}`)
    const gate = row.own ? (bad.length ? bad.join(', ') : 'ok') : 'no baseline entry'
    md.push(
      `| ${row.name} | ${run.questions} | ${pair(ref.tokensToGold, cur.tokensToGold)} | ${pair(ref.goldReached, cur.goldReached)} | ${pair(ref.hit5, cur.hit5)} | ${pair(ref.mrr, cur.mrr)} | ${gate} |`,
    )
  }
  return md
}

export function render(report, results) {
  const md = ['# Premise benchmark gate', '']
  md.push(report.ok ? '**Pass.**' : '**Fail.**', '')
  if (results) md.push(`Run ${results.runUrls.join(', ') || '(local)'}, commit ${results.commit ?? '(local)'}, suites ${results.selected.join(', ')}; median of ${results.instances} instances.`, '')
  if (report.failures.length) md.push('Failures:', '', ...report.failures.map((f) => `- ${f}`), '')
  if (report.notes.length) md.push(...report.notes.map((n) => `- ${n}`), '')
  if (report.suites.length) md.push(...overview(report), '')
  for (const row of report.suites) {
    const { run, own, base } = row
    md.push(`## ${row.name}: ${run.questions} questions`, '')
    md.push(`Index: ${run.index.outcome}, ${run.index.files} files, ${run.index.symbols} symbols, ${Math.round(run.index.ms / 1000)} s.`, '')
    if (run.instances) md.push(`Instances (Elara hit5 / tokensToGold): ${run.instances.map((i) => `${fmt(i.hit5)} / ${fmt(i.tokensToGold)}`).join('; ')}.`, '')
    const baseCol = base ? ' | base baseline' : ''
    const refV = (m) => (row.ref ? row.ref.elara[m] : own?.elara?.[m])
    md.push(`| metric | baseline (PR)${baseCol} | Elara (this run) | Δ vs reference | grep (this run) | gate |`)
    md.push(`|---|---|${baseCol ? '---|' : ''}---|---|---|---|`)
    for (const m of METRICS) {
      const b = base ? ` | ${fmt(base.elara[m])}` : ''
      md.push(`| ${m} | ${fmt(own?.elara?.[m])}${b} | ${fmt(run.aggregate.elara[m])} | ${delta(m, refV(m), run.aggregate.elara[m])} | ${fmt(run.aggregate.grep[m])} | ${row.verdicts[m] ?? ''} |`)
    }
    md.push('')
    if (run.paired) {
      const ratio = run.paired.grep > 0 ? ` Elara ÷ grep = ${fmt(Math.round((run.paired.elara / run.paired.grep) * 100) / 100)} (the phase-3 exit criterion is at most 1).` : ''
      md.push(`Questions both agents reach: ${run.paired.questions}; mean tokens-to-gold on those, Elara ${fmt(run.paired.elara)}, grep ${fmt(run.paired.grep)}.${ratio}`, '')
    }
    // The held-out suite reports numbers only: per-question detail would be tuning feedback (#1059).
    const failing = row.name === HOLDOUT ? [] : run.perQuestion.filter((q) => q.elara.tokensToGold === null || q.elara.exact1 === 0)
    if (failing.length) {
      md.push(`<details><summary>${failing.length} of ${run.questions} questions not exact (Elara)</summary>`, '', '| question | outcome | tokens-to-gold | first returned location |', '|---|---|---|---|')
      for (const q of failing) {
        const outcome = q.elara.tokensToGold === null ? (q.elara.abstained ? 'gold not reached (abstained)' : 'gold not reached') : q.elara.abstained ? 'abstained' : 'first location not on gold'
        md.push(`| ${q.id} | ${outcome} | ${fmt(q.elara.tokensToGold)} | ${q.elara.located ?? '-'} |`)
      }
      md.push('', '</details>', '')
    }
    const changes = row.name === HOLDOUT ? [] : questionChanges(row.ref ?? own, run)
    if (changes.length) md.push(`<details><summary>${changes.length} questions changed (Elara)</summary>`, '', ...changes.map((c) => `- ${c}`), '', '</details>', '')
  }
  md.push(
    `Gated: Elara ${GATED.join(', ')}, median of the instances. Tolerance: hit@5, exact@1 and gold-reached rate ${TOLERANCE.hit5Questions} questions per suite, tokens-to-gold ${TOLERANCE.tokensRelative * 100} %. Golds: zero count loss and no previously reached question missed or removed, including every changed baseline entry; owner exceptions must name every exact suite/question ID and cannot waive held-out ranking losses.${report.requireGolds ? ' Every base suite must run (--require-golds).' : ''} A miss costs ${results?.missCost?.tokens ?? '?'} tokens and ${results?.missCost?.calls ?? '?'} calls. Method: benchmarks/README.md.`,
  )
  return md.join('\n')
}

/** Two runs side by side: the noise the tolerances must exceed. */
export function compare(a, b) {
  const md = ['# Benchmark noise: two runs compared', '', `A: ${a.runUrl ?? '(local)'}`, `B: ${b.runUrl ?? '(local)'}`, '']
  for (const name of a.selected) {
    const sa = a.suites[name]
    const sb = b.suites[name]
    if (!sb) continue
    md.push(`## ${name}`, '', '| metric | elara A | elara B | Δ | grep A | grep B |', '|---|---|---|---|---|---|')
    for (const m of METRICS) {
      md.push(`| ${m} | ${fmt(sa.aggregate.elara[m])} | ${fmt(sb.aggregate.elara[m])} | ${delta(m, sa.aggregate.elara[m], sb.aggregate.elara[m])} | ${fmt(sa.aggregate.grep[m])} | ${fmt(sb.aggregate.grep[m])} |`)
    }
    const changes = questionChanges(toBaseline(combine([{ ...a, selected: [name] }])).suites[name], sb)
    md.push('', `Questions whose Elara rank or tokens-to-gold differ: ${changes.length}`, ...changes.map((c) => `- ${c}`), '')
  }
  return md.join('\n')
}

function readJson(file) {
  return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

function main() {
  const args = process.argv.slice(2)
  const opt = (name, fallback) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const baselineFile = opt('--baseline', 'benchmarks/baseline.json')
  if (args.includes('--compare')) {
    const i = args.indexOf('--compare')
    console.log(compare(readJson(args[i + 1]), readJson(args[i + 2])))
    return
  }
  const files = (opt('--write-baseline') ?? opt('--results', 'bench-results/results.json')).split(',').filter(Boolean)
  const list = files.map(readJson)
  const missing = files.filter((_, i) => !list[i])
  if (args.includes('--write-baseline')) {
    if (missing.length) throw new Error(`--write-baseline: missing ${missing.join(', ')}`)
    const json = JSON.stringify(toBaseline(combine(list), readJson(baselineFile) ?? { suites: {} }), null, 2)
    // One line per question ({ elara: [rank, tokens], grep: [...] }) keeps the table reviewable in a diff.
    const compact = json
      .replace(/\[\s*([^[\]{}]*?)\s*\]/g, (_, inner) => `[${inner.split(/,\s*/).join(', ')}]`)
      .replace(/\{\s*"elara": (\[[^\]]*\]),\s*"grep": (\[[^\]]*\])\s*\}/g, '{ "elara": $1, "grep": $2 }')
    writeFileSync(baselineFile, `${compact}\n`)
    console.log(`wrote ${baselineFile} (${Object.keys(list[0].suites).join(', ')}; median of ${list.length})`)
    return
  }
  const out = opt('--out', 'bench-results')
  const publish = (markdown) => {
    console.log(markdown)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'gate.md'), markdown)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  }
  if (missing.length) {
    publish(missingReport(missing))
    console.log(`::error title=bench-gate: missing results::${missing.map(artifactOf).join(', ')} missing: that bench instance failed, timed out or was cancelled`)
    process.exitCode = 1
    return
  }
  let results = null
  let report
  try {
    results = combine(list)
    const prJson = readJson(opt('--pr'))
    const pr = prJson ? { labels: (prJson.labels ?? []).map((l) => l.name ?? l), body: prJson.body ?? '' } : null
    // The files the PR changes, one per line (the workflow writes them from the pulls API): the held-out suite is locked against ranking changes (#1059).
    const changedFile = opt('--changed')
    const changed = changedFile && existsSync(changedFile) ? readFileSync(changedFile, 'utf8').split(/\r?\n/).filter(Boolean) : null
    report = evaluate({
      results,
      baseline: readJson(baselineFile),
      baseBaseline: readJson(opt('--base-baseline')),
      pr,
      requireGolds: args.includes('--require-golds'),
      changed,
    })
  } catch (err) {
    report = { ok: false, failures: [String(err.message ?? err)], notes: [], suites: [] }
  }
  publish(render(report, results))
  process.exitCode = report.ok ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
