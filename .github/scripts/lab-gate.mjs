// Lab gate (#576). Turns a lab run (lab-results/, written by lab/run.ts) into
// a pass/fail verdict against the committed baseline lab/known-defects.json,
// which maps every check that fails today to its open GitHub issue.
//
// The run fails when
//   1. a test crashed, timed out or wrote no result (harness failure);
//   2. a check failed that no baseline entry covers (regression);
//   3. a baseline entry is stale: its check passed, or (full tier) its test
//      ran and no longer reports a check by that name. Intermittent entries
//      may pass; they are only listed;
//   4. a baseline entry points at an issue that is closed, or at a PR;
//   5. the baseline itself is malformed.
// Inconclusive checks (ok: null) never fail the run; they are listed.
//
// Plain Node, no dependencies, one file: the workflow copies the base
// commit's version of this file alone to a temp dir on pull requests, so it
// must not import sibling modules. Docs: docs/agents/lab.md.
//
//   node .github/scripts/lab-gate.mjs [--results lab-results] [--baseline lab/known-defects.json]
// Issue states are read from the GitHub API when GITHUB_TOKEN and
// GITHUB_REPOSITORY are set; otherwise that rule is skipped (and said so).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Problems with the baseline file itself; empty = valid. */
export function validateBaseline(baseline) {
  const errors = []
  if (!baseline || !Array.isArray(baseline.defects)) return ['baseline has no "defects" array']
  baseline.defects.forEach((e, i) => {
    const at = `defects[${i}]`
    if (typeof e.test !== 'string' || !e.test) errors.push(`${at}: "test" must be a test name`)
    const hasCheck = typeof e.check === 'string' && e.check.length > 0
    const hasMatch = typeof e.match === 'string' && e.match.length > 0
    if (hasCheck === hasMatch) errors.push(`${at}: exactly one of "check" (exact name) or "match" (regex) is required`)
    if (hasMatch) {
      try {
        new RegExp(e.match)
      } catch (err) {
        errors.push(`${at}: "match" is not a valid regex: ${err.message}`)
      }
    }
    if (!Number.isInteger(e.issue) || e.issue <= 0) errors.push(`${at}: "issue" must be a GitHub issue number`)
    if (e.intermittent !== undefined && (typeof e.intermittent !== 'string' || e.intermittent.length < 10)) {
      errors.push(`${at}: "intermittent" must say why the check sometimes passes (10+ characters)`)
    }
  })
  return errors
}

export function entryMatches(entry, test, checkName) {
  if (entry.test !== test) return false
  return entry.check !== undefined ? entry.check === checkName : new RegExp(entry.match).test(checkName)
}

export function entryLabel(entry) {
  return entry.check !== undefined ? entry.check : `/${entry.match}/`
}

/**
 * run: lab-results/run.json ({ tier, tests }) or null when the runner never
 * got that far. results: test name -> lab-results/<test>.json.
 * issueStates: issue number -> 'open' | 'closed' | 'pr' | 'missing', or
 * null when they could not be read.
 */
export function evaluate({ run, results, baseline, issueStates }) {
  const report = {
    tier: run?.tier ?? null,
    tests: run?.tests ?? [],
    baselineErrors: validateBaseline(baseline),
    noRun: !run,
    crashed: [],
    missing: [],
    regressions: [],
    known: [],
    stale: [],
    intermittentPassed: [],
    inconclusive: [],
    issueProblems: [],
    issueStatesChecked: issueStates !== null,
    passedChecks: 0,
  }
  const entries = report.baselineErrors.length === 0 ? baseline.defects : []

  for (const test of report.tests) {
    const r = results[test]
    if (!r) report.missing.push(test)
    else if (r.harness !== 'ok') report.crashed.push({ test, error: String(r.error ?? 'unknown error').split('\n')[0] })
  }
  const ran = report.tests.filter((t) => results[t]?.harness === 'ok')

  for (const test of ran) {
    for (const c of results[test].checks ?? []) {
      if (c.ok === true) report.passedChecks++
      else if (c.ok === null) report.inconclusive.push({ test, check: c.name, actual: c.actual })
      else if (!entries.some((e) => entryMatches(e, test, c.name))) {
        report.regressions.push({ test, check: c.name, expected: c.expected, actual: c.actual, severity: c.severity ?? '' })
      }
    }
  }

  for (const entry of entries) {
    if (!ran.includes(entry.test)) continue
    const matched = (results[entry.test].checks ?? []).filter((c) => entryMatches(entry, entry.test, c.name))
    const failed = matched.filter((c) => c.ok === false).length
    const passed = matched.filter((c) => c.ok === true).length
    if (failed > 0) report.known.push({ entry, failed, of: matched.length })
    else if (matched.length === 0) {
      // A fast-tier run skips the long parts of some tests, so a missing check
      // only means "renamed or removed" in the full tier.
      if (report.tier === 'full') report.stale.push({ entry, reason: 'the test no longer reports this check' })
    } else if (passed > 0) {
      if (entry.intermittent) report.intermittentPassed.push(entry)
      else report.stale.push({ entry, reason: `passed (${passed}/${matched.length} matching checks ok)` })
    }
  }

  if (issueStates) {
    for (const issue of [...new Set(entries.map((e) => e.issue))]) {
      const state = issueStates[issue]
      if (state !== 'open') report.issueProblems.push({ issue, state: state ?? 'missing' })
    }
  }

  report.ok =
    !report.noRun &&
    report.baselineErrors.length === 0 &&
    report.crashed.length === 0 &&
    report.missing.length === 0 &&
    report.regressions.length === 0 &&
    report.stale.length === 0 &&
    report.issueProblems.length === 0
  return report
}

const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .slice(0, 240)

export function render(report, repo = 'PIIIX-org/chapters') {
  const issue = (n) => `[#${n}](https://github.com/${repo}/issues/${n})`
  const md = [`# Lab gate: ${report.ok ? 'PASS' : 'FAIL'}`, '']
  if (report.noRun) {
    md.push('lab-results/run.json is missing: the runner never started (bootstrap or build failed). See the job log.', '')
    return md.join('\n')
  }
  md.push(
    `Tier **${report.tier}**, ${report.tests.length} tests. ${report.passedChecks} checks passed, ` +
      `${report.known.reduce((n, k) => n + k.failed, 0)} failed as known defects (${report.known.length} baseline entries), ` +
      `${report.regressions.length} regressions, ${report.stale.length} stale entries, ${report.crashed.length + report.missing.length} harness failures, ` +
      `${report.inconclusive.length} inconclusive.`,
    '',
  )
  if (report.baselineErrors.length) {
    md.push('## Baseline file is invalid (lab/known-defects.json)', '', ...report.baselineErrors.map((e) => `- ${e}`), '')
  }
  if (report.crashed.length || report.missing.length) {
    md.push('## Harness failures', '', 'A test threw, timed out or wrote no result: fix the test or the instance before reading its checks.', '')
    for (const c of report.crashed) md.push(`- \`${c.test}\`: ${cell(c.error)}`)
    for (const t of report.missing) md.push(`- \`${t}\`: no result file`)
    md.push('')
  }
  if (report.regressions.length) {
    md.push(
      '## Regressions (failed, not in the baseline)',
      '',
      'Fix the code, or, if this is a known defect newly measured, open an issue and add an entry to lab/known-defects.json.',
      '',
      '| test | check | severity | expected | actual |',
      '|---|---|---|---|---|',
      ...report.regressions.map((r) => `| ${r.test} | ${cell(r.check)} | ${r.severity} | ${cell(r.expected)} | ${cell(r.actual)} |`),
      '',
    )
  }
  if (report.stale.length) {
    md.push(
      '## Stale baseline entries',
      '',
      'The defect no longer shows: remove the entry from lab/known-defects.json and close (or comment on) the issue, linking this run.',
      '',
      '| test | check | issue | why |',
      '|---|---|---|---|',
      ...report.stale.map((s) => `| ${s.entry.test} | ${cell(entryLabel(s.entry))} | ${issue(s.entry.issue)} | ${s.reason} |`),
      '',
    )
  }
  if (report.issueProblems.length) {
    md.push(
      '## Baseline entries without an open issue',
      '',
      'Every known defect needs an open issue. Reopen it, point the entry at the right one, or drop the entry if the defect is gone.',
      '',
      ...report.issueProblems.map((p) => `- ${issue(p.issue)}: ${p.state}`),
      '',
    )
  }
  if (!report.issueStatesChecked) md.push('Issue states were not checked (no GITHUB_TOKEN).', '')
  if (report.known.length) {
    md.push(
      '## Known defects (still failing, as expected)',
      '',
      '| test | check | issue | failing |',
      '|---|---|---|---|',
      ...report.known.map((k) => `| ${k.entry.test} | ${cell(entryLabel(k.entry))} | ${issue(k.entry.issue)} | ${k.failed}/${k.of} |`),
      '',
    )
  }
  if (report.intermittentPassed.length) {
    md.push(
      '## Intermittent known defects that passed this time',
      '',
      ...report.intermittentPassed.map((e) => `- ${e.test}: ${cell(entryLabel(e))} (${issue(e.issue)}): ${e.intermittent}`),
      '',
    )
  }
  if (report.inconclusive.length) {
    md.push(
      '## Inconclusive checks (not judged)',
      '',
      ...report.inconclusive.map((c) => `- ${c.test}: ${cell(c.check)}: ${cell(c.actual)}`),
      '',
    )
  }
  return md.join('\n')
}

async function fetchIssueStates(baseline, repo, token) {
  const states = {}
  for (const n of [...new Set(baseline.defects.map((e) => e.issue))]) {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${n}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
    if (res.status === 404) states[n] = 'missing'
    else if (!res.ok) throw new Error(`GitHub API ${res.status} for issue #${n}: ${await res.text()}`)
    else {
      const body = await res.json()
      states[n] = body.pull_request ? 'pr' : body.state
    }
  }
  return states
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name, fallback) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const resultsDir = opt('--results', 'lab-results')
  const baseline = readJson(opt('--baseline', 'lab/known-defects.json'))
  const run = readJson(join(resultsDir, 'run.json'))
  const results = {}
  for (const test of run?.tests ?? []) {
    const r = readJson(join(resultsDir, `${test}.json`))
    if (r) results[test] = r
  }
  const repo = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  const valid = validateBaseline(baseline).length === 0
  const issueStates = repo && token && valid ? await fetchIssueStates(baseline, repo, token) : null
  const report = evaluate({ run, results, baseline, issueStates })
  const markdown = render(report, repo)
  console.log(markdown)
  if (existsSync(resultsDir)) writeFileSync(join(resultsDir, 'gate.md'), `${markdown}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  process.exit(report.ok ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
