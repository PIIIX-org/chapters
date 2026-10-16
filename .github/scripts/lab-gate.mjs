// Lab gate (#576). Turns a lab run (lab-results/, written by lab/run.ts) into
// a pass/fail verdict against the committed baseline lab/known-defects.json,
// which maps every check that does not pass today (failed, or inconclusive)
// to its open GitHub issue.
//
// The run fails when
//   1. a test crashed, timed out, wrote no result or reported no checks
//      (harness failure), or the runner never started;
//   2. a check failed, or came out inconclusive (ok: null), and no baseline
//      entry for that state covers it (regression);
//   3. a baseline entry is stale: its checks are no longer in that state
//      (intermittent entries excepted), or, in an unfiltered full-tier run,
//      its check or its whole test is no longer reported;
//   4. a regex entry covers more than one kind of check in this run (kinds =
//      check names with their numbers taken out), so a family can never hide
//      a different check that happens to share its prefix;
//   5. a baseline entry points at an issue that is closed, or at a PR;
//   6. the baseline itself is malformed (regexes must be anchored ^...$).
//
// `--lint <dir>[,<dir>...]` checks the baseline against the runs it was built
// from instead: every entry (every kind of a regex entry) must have been in
// its state in at least one of them. Run it when regenerating the baseline.
//
// Plain Node, no dependencies, one file: the workflow copies the base
// commit's version of this file alone to a temp dir on pull requests, so it
// must not import sibling modules. Docs: docs/agents/lab.md.
//
//   node .github/scripts/lab-gate.mjs [--results lab-results] [--baseline lab/known-defects.json]
//   node .github/scripts/lab-gate.mjs --lint runs/a,runs/b [--baseline lab/known-defects.json]
// Issue states are read from the GitHub API when GITHUB_TOKEN and
// GITHUB_REPOSITORY are set; otherwise that rule is skipped (and said so).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STATES = ['failed', 'inconclusive']

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
      if (!e.match.startsWith('^') || !e.match.endsWith('$')) errors.push(`${at}: "match" must be anchored (^...$)`)
      try {
        new RegExp(e.match)
      } catch (err) {
        errors.push(`${at}: "match" is not a valid regex: ${err.message}`)
      }
    }
    if (e.state !== undefined && !STATES.includes(e.state)) errors.push(`${at}: "state" must be "failed" or "inconclusive"`)
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

/** The state an entry expects: 'failed' (default) or 'inconclusive'. */
export const entryState = (entry) => entry.state ?? 'failed'

/** 'passed' | 'failed' | 'inconclusive' for one check (anything but true/null fails closed). */
export const checkState = (c) => (c.ok === true ? 'passed' : c.ok === null ? 'inconclusive' : 'failed')

/**
 * The kind of a check: its name with every number (and a letter glued to its
 * front, as in `t100`, `a38`, `S17`, `N=5`) replaced by `#`. Checks of one
 * regex family differ only in such parameters.
 */
export const checkKind = (name) => name.replace(/[A-Za-z]?\d+/g, '#')

/**
 * run: lab-results/run.json ({ tier, filters, tests, available? }) or null
 * when the runner never got that far. results: test name ->
 * lab-results/<test>.json. issueStates: issue number -> 'open' | 'closed' |
 * 'pr' | 'missing', or null when they could not be read.
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
    families: [],
    intermittentPassed: [],
    issueProblems: [],
    issueStatesChecked: issueStates !== null,
    passedChecks: 0,
  }
  const entries = report.baselineErrors.length === 0 ? baseline.defects : []
  // Only an unfiltered full-tier run reports every check, so only there does
  // "not reported" mean "renamed or removed".
  const complete = report.tier === 'full' && (run?.filters ?? []).length === 0

  for (const test of report.tests) {
    const r = results[test]
    if (!r) report.missing.push(test)
    else if (r.harness !== 'ok') report.crashed.push({ test, error: String(r.error ?? 'unknown error').split('\n')[0] })
    else if (!Array.isArray(r.checks) || r.checks.length === 0) report.crashed.push({ test, error: 'reported no checks' })
  }
  const ran = report.tests.filter((t) => results[t]?.harness === 'ok' && results[t].checks?.length > 0)

  for (const test of ran) {
    for (const c of results[test].checks) {
      const state = checkState(c)
      if (state === 'passed') report.passedChecks++
      else if (!entries.some((e) => entryState(e) === state && entryMatches(e, test, c.name))) {
        report.regressions.push({ test, check: c.name, state, expected: c.expected, actual: c.actual, severity: c.severity ?? '' })
      }
    }
  }

  for (const entry of entries) {
    if (!ran.includes(entry.test)) {
      if (complete && !report.tests.includes(entry.test)) report.stale.push({ entry, reason: 'the test no longer exists' })
      continue
    }
    const matched = results[entry.test].checks.filter((c) => entryMatches(entry, entry.test, c.name))
    if (entry.match !== undefined) {
      const kinds = [...new Set(matched.map((c) => checkKind(c.name)))]
      if (kinds.length > 1) report.families.push({ entry, kinds })
    }
    const inState = matched.filter((c) => checkState(c) === entryState(entry)).length
    if (inState > 0) report.known.push({ entry, count: inState, of: matched.length })
    else if (matched.length === 0) {
      if (complete) report.stale.push({ entry, reason: 'the test no longer reports this check' })
    } else if (entry.intermittent) report.intermittentPassed.push(entry)
    else {
      const states = matched.map(checkState).join(', ')
      report.stale.push({ entry, reason: `no longer ${entryState(entry)} (${states})` })
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
    report.families.length === 0 &&
    report.issueProblems.length === 0
  return report
}

/**
 * Checks a baseline against the runs it was built from (each: { results }).
 * Every exact entry, and every kind of check a regex entry covers, must have
 * been in the entry's state in at least one run. Returns problems (empty = ok).
 */
export function lintBaseline(baseline, runs) {
  const errors = validateBaseline(baseline)
  if (errors.length) return errors
  for (const entry of baseline.defects) {
    const byKind = new Map()
    for (const { results } of runs) {
      for (const c of results[entry.test]?.checks ?? []) {
        if (!entryMatches(entry, entry.test, c.name)) continue
        const kind = entry.match !== undefined ? checkKind(c.name) : c.name
        const hit = byKind.get(kind) ?? false
        byKind.set(kind, hit || checkState(c) === entryState(entry))
      }
    }
    if (byKind.size === 0) errors.push(`${entry.test}: ${entryLabel(entry)}: matches no check in these runs`)
    for (const [kind, hit] of byKind) {
      if (!hit) errors.push(`${entry.test}: ${entryLabel(entry)}: covers "${kind}", which was never ${entryState(entry)} in these runs`)
    }
  }
  return errors
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
  const known = (state) => report.known.filter((k) => entryState(k.entry) === state).reduce((n, k) => n + k.count, 0)
  md.push(
    `Tier **${report.tier}**, ${report.tests.length} tests. ${report.passedChecks} checks passed, ` +
      `${known('failed')} failed and ${known('inconclusive')} inconclusive as known (${report.known.length} baseline entries), ` +
      `${report.regressions.length} regressions, ${report.stale.length} stale entries, ${report.families.length} over-broad families, ` +
      `${report.crashed.length + report.missing.length} harness failures.`,
    '',
  )
  if (report.baselineErrors.length) {
    md.push('## Baseline file is invalid (lab/known-defects.json)', '', ...report.baselineErrors.map((e) => `- ${e}`), '')
  }
  if (report.crashed.length || report.missing.length) {
    md.push('## Harness failures', '', 'A test threw, timed out, wrote no result or reported no checks: fix the test or the instance before reading its checks.', '')
    for (const c of report.crashed) md.push(`- \`${c.test}\`: ${cell(c.error)}`)
    for (const t of report.missing) md.push(`- \`${t}\`: no result file`)
    md.push('')
  }
  if (report.regressions.length) {
    md.push(
      '## Regressions (failed or inconclusive, not in the baseline)',
      '',
      'Fix the code (an inconclusive check means a precondition broke: tokens, the instance, a fixture). If this is a known defect newly measured, open an issue and add an entry to lab/known-defects.json.',
      '',
      '| test | check | state | severity | expected | actual |',
      '|---|---|---|---|---|---|',
      ...report.regressions.map((r) => `| ${r.test} | ${cell(r.check)} | ${r.state} | ${r.severity} | ${cell(r.expected)} | ${cell(r.actual)} |`),
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
  if (report.families.length) {
    md.push(
      '## Regex entries that cover more than one kind of check',
      '',
      'A family entry may only differ in numbers (kill delay, N, round). Narrow the regex or split it into one entry per kind.',
      '',
      ...report.families.map((f) => `- ${f.entry.test}: ${cell(entryLabel(f.entry))}: ${f.kinds.map(cell).join(' / ')}`),
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
      '## Known defects (as expected)',
      '',
      '| test | check | state | issue | count |',
      '|---|---|---|---|---|',
      ...report.known.map(
        (k) => `| ${k.entry.test} | ${cell(entryLabel(k.entry))} | ${entryState(k.entry)} | ${issue(k.entry.issue)} | ${k.count}/${k.of} |`,
      ),
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

function readRun(dir) {
  const run = readJson(join(dir, 'run.json'))
  const results = {}
  for (const test of run?.tests ?? []) {
    const r = readJson(join(dir, `${test}.json`))
    if (r) results[test] = r
  }
  return { run, results }
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name, fallback) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const baseline = readJson(opt('--baseline', 'lab/known-defects.json'))
  const lintDirs = opt('--lint', null)
  if (lintDirs) {
    const problems = lintBaseline(baseline, lintDirs.split(',').map(readRun))
    for (const p of problems) console.log(`- ${p}`)
    console.log(problems.length ? `${problems.length} baseline problems` : 'baseline lint: ok')
    process.exit(problems.length ? 1 : 0)
  }
  const resultsDir = opt('--results', 'lab-results')
  const { run, results } = readRun(resultsDir)
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
