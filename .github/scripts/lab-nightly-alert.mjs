// Nightly lab alert (#706). Runs as the last job of the Elara lab workflow
// (.github/workflows/elara-lab.yml, job `nightly-alert`) and keeps one issue
// labelled ISSUE_LABEL in step with the scheduled full-tier run on `dev`:
//   - red run, no open issue  -> open one: failed jobs, run link, gate summary
//   - red run, issue open     -> comment on it with the same
//   - green run, issue open   -> comment with the run link, close it
//   - green run, none open    -> nothing
// Red = a job failed or was cancelled, or the lab job did not run.
// The gate summary is lab-results/gate.md (lab-gate.mjs) without its
// known-defect tables, plus bench-gate/gate.md when the benchmark failed.
//
// Posts only for a `schedule` event on refs/heads/dev of LIVE_REPO; pull
// requests, pushes, dispatches and forks never write. `--dry-run` (the
// workflow's `alert_dry_run` dispatch input) reads the open issue and prints
// what a scheduled run would post, on any event.
//
//   node .github/scripts/lab-nightly-alert.mjs [--needs <toJSON(needs) file>]
//     [--lab-gate lab-results/gate.md] [--bench-gate bench-gate/gate.md] [--dry-run]
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_REF,
// GITHUB_SERVER_URL, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT (all set by Actions),
// NEEDS (the jobs' results as JSON, when --needs is not given).
// Docs: docs/agents/lab.md (Nightly alert). Plain Node, no dependencies.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const ISSUE_TITLE = 'Nightly lab failing'
export const ISSUE_LABEL = 'lab-nightly'
export const LIVE_REPO = 'PIIIX-org/chapters'
export const LIVE_REF = 'refs/heads/dev'
/** GitHub's limit for an issue or comment body is 65536 characters. */
export const MAX_BODY = 60000
const RED = new Set(['failure', 'cancelled'])
/** Gate sections that list what is as expected: left out of the alert. */
const QUIET_SECTIONS = /^## (Known defects|Intermittent known defects)/

/** 'live' (posts), 'dry-run' (reads, prints) or 'skip' (no API call). */
export function mode({ event, ref, repo, dryRun }) {
  if (dryRun) return 'dry-run'
  return event === 'schedule' && ref === LIVE_REF && repo === LIVE_REPO
    ? 'live'
    : 'skip'
}

/**
 * `toJSON(needs)` -> `{ failed, jobs }`: jobs that failed or were cancelled,
 * and `lab` when it did not succeed (a skipped lab means `plan` broke).
 */
export function runVerdict(needs) {
  const jobs = []
  for (const [job, n] of Object.entries(needs ?? {})) {
    const result = n?.result ?? 'unknown'
    if (RED.has(result) || (job === 'lab' && result !== 'success'))
      jobs.push({ job, result })
  }
  if (!needs?.lab) jobs.push({ job: 'lab', result: 'missing' })
  return { failed: jobs.length > 0, jobs }
}

/**
 * A gate's Markdown for the alert: headings two levels down (it sits under
 * the alert's own), the known-defect and intermittent tables dropped (they
 * are what is expected, and long). Empty -> null.
 */
export function gateSummary(markdown) {
  if (!markdown?.trim()) return null
  const out = []
  let quiet = false
  for (const line of markdown.trim().split('\n')) {
    if (/^#{1,2} /.test(line)) quiet = QUIET_SECTIONS.test(line)
    if (quiet) continue
    out.push(/^#{1,4} /.test(line) ? `##${line}` : line)
  }
  return out.join('\n').trim()
}

/** Open ISSUE_LABEL issues titled ISSUE_TITLE, every page. */
async function openIssues(api, repo) {
  const found = []
  for (
    let next = `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(ISSUE_LABEL)}&per_page=100`;
    next;
  ) {
    const page = await api(next)
    found.push(
      ...page.data.filter((i) => !i.pull_request && i.title === ISSUE_TITLE),
    )
    next = page.next
  }
  return found
}

/** Red: open (none open) or update (the oldest open one). Green: close every open one. */
export function decide({ failed, open }) {
  const oldest = [...open].sort((a, b) => a.number - b.number)
  if (failed)
    return oldest.length
      ? { action: 'update', issues: oldest.slice(0, 1) }
      : { action: 'open', issues: [] }
  return oldest.length
    ? { action: 'close', issues: oldest }
    : { action: 'none', issues: [] }
}

/** Markdown for a red run (issue body or comment), at most MAX_BODY characters. */
export function failureText({ verdict, runUrl, labGate, benchGate }) {
  const head = [
    `The scheduled full-tier lab run on \`dev\` failed: ${runUrl}`,
    '',
    `Jobs: ${verdict.jobs.map((j) => `\`${j.job}\`: ${j.result}`).join(', ')}.`,
    '',
  ].join('\n')
  const lab =
    gateSummary(labGate) ??
    '_No lab gate summary: the lab job ended before the gate step or uploaded no results. See the run._'
  const bench = verdict.jobs.some(
    (j) => j.job === 'bench' || j.job === 'bench-gate',
  )
    ? gateSummary(benchGate)
    : null
  const tail = [
    '',
    '---',
    'Posted by the `nightly-alert` job (`.github/scripts/lab-nightly-alert.mjs`, #706). The next green nightly closes this issue. Gate rules: `docs/agents/lab.md`.',
  ].join('\n')
  let gates = [lab, ...(bench ? ['', bench] : [])].join('\n')
  const room = MAX_BODY - head.length - tail.length
  if (gates.length > room) {
    const note = `\n\n_Summary cut at ${room} characters: the full gate output is in the run's summary and its \`lab-results\` artifact._`
    gates = gates.slice(0, room - note.length) + note
  }
  return `${head}${gates}${tail}`
}

export function recoveryText({ runUrl }) {
  return `The scheduled full-tier lab run on \`dev\` passed again: ${runUrl}\n\nClosing (\`nightly-alert\`, #706).`
}

/**
 * Applies decide() through `api(path, { method, body }) -> { data, next }`.
 * Returns what it did (or, in a dry run, would do): `{ action, issue, body, dryRun }`.
 */
export async function alert({
  api,
  repo,
  mode: m,
  verdict,
  runUrl,
  labGate,
  benchGate,
}) {
  if (m === 'skip')
    return { action: 'skip', issue: null, body: null, dryRun: false }
  const dryRun = m !== 'live'
  const { action, issues } = decide({
    failed: verdict.failed,
    open: await openIssues(api, repo),
  })
  const body = verdict.failed
    ? failureText({ verdict, runUrl, labGate, benchGate })
    : action === 'close'
      ? recoveryText({ runUrl })
      : null
  let issue = issues[0]?.html_url ?? null
  if (!dryRun) {
    if (action === 'open') {
      const { data } = await api(`/repos/${repo}/issues`, {
        method: 'POST',
        body: { title: ISSUE_TITLE, labels: [ISSUE_LABEL], body },
      })
      issue = data.html_url
    } else if (action === 'update') {
      await api(`/repos/${repo}/issues/${issues[0].number}/comments`, {
        method: 'POST',
        body: { body },
      })
    } else if (action === 'close') {
      for (const i of issues) {
        // Comment first: it notifies the issue's subscribers; closing alone may not.
        await api(`/repos/${repo}/issues/${i.number}/comments`, {
          method: 'POST',
          body: { body },
        })
        await api(`/repos/${repo}/issues/${i.number}`, {
          method: 'PATCH',
          body: { state: 'closed', state_reason: 'completed' },
        })
      }
    }
  }
  return { action, issue, body, dryRun }
}

// ---------------------------------------------------------------------------
// Runner

/** One GitHub API call -> `{ data, next }` (`next`: the Link header's next page URL). */
async function githubApi(path, { method = 'GET', body } = {}) {
  const url = path.startsWith('https://')
    ? path
    : `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok)
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return {
    data: await res.json(),
    next: /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1],
  }
}

const readIf = (file) =>
  file && existsSync(file) ? readFileSync(file, 'utf8') : null

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : null
  }
  const env = process.env
  const needsFile = opt('--needs')
  const needs = JSON.parse(
    needsFile ? readFileSync(needsFile, 'utf8') : (env.NEEDS ?? '{}'),
  )
  const m = mode({
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    repo: env.GITHUB_REPOSITORY,
    dryRun: args.includes('--dry-run'),
  })
  const verdict = runVerdict(needs)
  if (m !== 'skip' && (!env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN))
    throw new Error('needs GITHUB_REPOSITORY and GITHUB_TOKEN')
  const runUrl = `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}${
    Number(env.GITHUB_RUN_ATTEMPT) > 1
      ? `/attempts/${env.GITHUB_RUN_ATTEMPT}`
      : ''
  }`
  const r = await alert({
    api: githubApi,
    repo: env.GITHUB_REPOSITORY,
    mode: m,
    verdict,
    runUrl,
    labGate: readIf(opt('--lab-gate')),
    benchGate: readIf(opt('--bench-gate')),
  })
  console.log(JSON.stringify({ mode: m, verdict, ...r }))
  const what = {
    skip: `skipped: posts only for a \`schedule\` run on \`${LIVE_REF}\` of ${LIVE_REPO} (event \`${env.GITHUB_EVENT_NAME}\`, ref \`${env.GITHUB_REF}\`)`,
    none: 'green, no open issue: nothing to do',
    open: 'red: open a new issue',
    update: `red: comment on ${r.issue}`,
    close: `green: comment on and close ${r.issue}`,
  }[r.action]
  summary(
    [
      `## Nightly lab alert${r.dryRun ? ' (dry run: nothing posted)' : ''}`,
      '',
      `Run ${verdict.failed ? 'red' : 'green'}; ${what}.${r.action === 'open' && !r.dryRun ? ` ${r.issue}` : ''}`,
      ...(r.body
        ? ['', `${r.dryRun ? 'Would post' : 'Posted'}:`, '', r.body]
        : []),
    ].join('\n'),
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    summary(
      `## Nightly lab alert could not run\n\n\`\`\`\n${err?.stack ?? err}\n\`\`\``,
    )
    console.error(err)
    process.exit(1)
  })
}
