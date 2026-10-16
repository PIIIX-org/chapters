// Generated part of docs/agents/STATE.md (#582). Rebuilds the block between
// START and END from GitHub data: the last promotion to `prod`, the latest
// CI, nightly lab and bench-gate results on `dev`, progress of the `Phase N`
// milestones, open issues by priority and label, owner actions, open bugs
// and the open issues of the phase in progress. Everything outside the
// markers (Architecture Traps, Decided against, ...) is hand-written and
// left alone.
//
// The output depends only on GitHub state, never on the time or on run ids
// of passing runs, so regenerating after merging the bot's own PR gives the
// same text and opens no new PR. Workflow: .github/workflows/state-md.yml;
// docs: docs/agents/github-workflow.md (STATE.md).
//
// Usage (plain Node, no dependencies):
//   node .github/scripts/state-md.mjs [--file docs/agents/STATE.md] [--repo owner/name]
// Token: GITHUB_TOKEN, GH_TOKEN, or `gh auth token`. Repo: --repo or
// GITHUB_REPOSITORY. Writes the file only when the block changed; prints the
// block; in Actions also writes the step summary and `changed=true|false`
// to GITHUB_OUTPUT.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const START = '<!-- state:generated:start -->'
export const END = '<!-- state:generated:end -->'

/** At most this many issues per list; the rest are a count and a link. */
export const MAX_LIST = 12
/** Labels counted in the open-issues line, in this order. */
export const COUNTED_LABELS = ['bug', 'security', 'decision', 'deferred']
const PRIORITIES = ['P0', 'P1', 'P2']
const PHASE = /^Phase (\d+)\b/

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** A title cut to `max` characters at a word boundary, with an ellipsis. */
export function shorten(s, max = 90) {
  const t = one(s)
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  // Keep the last word only if the cut falls right after it.
  const space = t[max - 1] === ' ' ? cut.length : cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** 'P0' | 'P1' | 'P2' | null. */
export function priorityOf(issue) {
  return PRIORITIES.find((p) => issue.labels.includes(p)) ?? null
}

const rank = (issue) => {
  const p = priorityOf(issue)
  return p ? PRIORITIES.indexOf(p) : PRIORITIES.length
}

/** Issues by priority (P0 first, unprioritised last), then by number. */
export function sortIssues(issues) {
  return [...issues].sort((a, b) => rank(a) - rank(b) || a.number - b.number)
}

/** The `Phase N` milestones, in phase order. */
export function phases(milestones) {
  return milestones
    .filter((m) => PHASE.test(m.title))
    .sort((a, b) => Number(PHASE.exec(a.title)[1]) - Number(PHASE.exec(b.title)[1]) || a.number - b.number)
}

function issueLine(i) {
  const p = priorityOf(i)
  return `  - #${i.number} ${shorten(i.title)}${p ? ` (${p})` : ''}`
}

function issueList(issues, moreUrl) {
  const sorted = sortIssues(issues)
  const lines = sorted.slice(0, MAX_LIST).map(issueLine)
  const rest = sorted.length - MAX_LIST
  if (rest > 0) lines.push(`  - … and ${rest} more: ${moreUrl}`)
  return lines
}

function runState(label, run, conclusion = run?.conclusion) {
  if (!run) return `${label} no completed run`
  const c = conclusion ?? 'not run'
  return c === 'success' ? `${label} ${c}` : `${label} **${c}** ([run](${run.url}))`
}

/**
 * The generated block, markers included. `data`:
 * { repo, promotion: { number, title, mergedAt, sha } | null,
 *   ci: { conclusion, url } | null,
 *   lab: { conclusion, url, jobs: { [name]: conclusion } } | null,
 *   milestones: [{ number, title, open, closed }],
 *   issues: [{ number, title, labels: [name], milestone: number | null }] }
 */
export function render(data) {
  const gh = `https://github.com/${data.repo}`
  const lines = [
    START,
    '<!-- Built by .github/scripts/state-md.mjs from GitHub data (workflow .github/workflows/state-md.yml). Edits between these markers are overwritten. -->',
  ]

  const p = data.promotion
  lines.push(
    p
      ? `- **Last promotion to \`prod\`**: #${p.number} ${shorten(p.title)} (merged ${p.mergedAt.slice(0, 10)}, \`${p.sha.slice(0, 7)}\`).`
      : '- **Last promotion to `prod`**: none found.',
  )

  const lab = data.lab
  lines.push(
    '- **Checks on `dev`**: ' +
      [
        runState('CI (latest push run)', data.ci),
        runState('nightly lab (full tier)', lab, lab ? lab.jobs.lab : undefined),
        runState('bench-gate (all suites)', lab, lab ? lab.jobs['bench-gate'] : undefined),
      ].join('; ') +
      `. History: [CI](${gh}/actions/workflows/ci.yml?query=branch%3Adev), [lab](${gh}/actions/workflows/elara-lab.yml?query=branch%3Adev+event%3Aschedule).`,
  )

  const ph = phases(data.milestones)
  lines.push(
    '- **Phases** (milestones, closed of total): ' +
      (ph.length
        ? ph.map((m) => `[${one(m.title)}](${gh}/milestone/${m.number}) ${m.closed}/${m.open + m.closed}`).join(', ')
        : 'none') +
      '.',
  )

  const issues = data.issues
  const byPriority = PRIORITIES.map((x) => `${x} ${issues.filter((i) => priorityOf(i) === x).length}`)
  const none = issues.filter((i) => priorityOf(i) === null).length
  const byLabel = COUNTED_LABELS.map((l) => `\`${l}\` ${issues.filter((i) => i.labels.includes(l)).length}`)
  lines.push(
    `- **Open issues**: [${issues.length}](${gh}/issues): ${byPriority.join(', ')}, no priority ${none}; ${byLabel.join(', ')}.`,
  )

  const owner = issues.filter((i) => i.labels.includes('owner'))
  lines.push(`- **Owner actions** (label \`owner\`)${owner.length ? ':' : ': none.'}`)
  lines.push(...issueList(owner, `${gh}/issues?q=is%3Aopen+label%3Aowner`))

  // The first phase with open work an agent can do (owner actions are listed above).
  const current = ph
    .map((m) => ({ m, open: issues.filter((i) => i.milestone === m.number && !i.labels.includes('owner')) }))
    .find((x) => x.open.length > 0)
  if (current) {
    lines.push(
      `- **In progress: [${one(current.m.title)}](${gh}/milestone/${current.m.number})** (${current.open.length} open, owner actions excluded):`,
    )
    lines.push(...issueList(current.open, `${gh}/milestone/${current.m.number}`))
  } else {
    lines.push('- **In progress**: no phase milestone has open issues.')
  }

  const bugs = issues.filter((i) => i.labels.includes('bug'))
  lines.push(`- **Open bugs** (label \`bug\`)${bugs.length ? ':' : ': none.'}`)
  lines.push(...issueList(bugs, `${gh}/issues?q=is%3Aopen+label%3Abug`))

  lines.push(END)
  return lines.join('\n')
}

/** `doc` with its generated block replaced by `block`. */
export function replaceBlock(doc, block) {
  const start = doc.indexOf(START)
  const end = doc.indexOf(END)
  if (start < 0 || end < 0) throw new Error(`STATE.md has no ${start < 0 ? START : END} marker`)
  if (doc.indexOf(START, start + 1) >= 0 || doc.indexOf(END, end + 1) >= 0) {
    throw new Error('STATE.md has more than one generated block')
  }
  if (end < start) throw new Error(`${END} comes before ${START} in STATE.md`)
  return doc.slice(0, start) + block + doc.slice(end + END.length)
}

// ---------------------------------------------------------------------------
// GitHub data

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
}

async function api(path, auth) {
  const url = path.startsWith('https://') ? path : `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${auth}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  })
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`)
  return { data: await res.json(), next: /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] }
}

async function all(path, auth, pick = (d) => d) {
  const out = []
  for (let next = path; next; ) {
    const page = await api(next, auth)
    out.push(...pick(page.data))
    next = page.next
  }
  return out
}

async function latestRun(r, workflow, event, auth) {
  const { data } = await api(
    `${r}/actions/workflows/${workflow}/runs?branch=dev&event=${event}&status=completed&per_page=1`,
    auth,
  )
  return data.workflow_runs?.[0] ?? null
}

/** The `data` for render(), read from the REST API. */
export async function fetchData(repo, auth) {
  const r = `/repos/${repo}`
  const [issues, milestones, prodPulls, ci, lab] = await Promise.all([
    all(`${r}/issues?state=open&per_page=100`, auth),
    all(`${r}/milestones?state=all&per_page=100`, auth),
    api(`${r}/pulls?state=closed&base=prod&sort=updated&direction=desc&per_page=50`, auth),
    latestRun(r, 'ci.yml', 'push', auth),
    latestRun(r, 'elara-lab.yml', 'schedule', auth),
  ])
  const promotion = prodPulls.data
    .filter((p) => p.merged_at)
    .sort((a, b) => b.merged_at.localeCompare(a.merged_at))[0]
  const jobs = lab ? await all(`${r}/actions/runs/${lab.id}/jobs?per_page=100`, auth, (d) => d.jobs) : []
  return {
    repo,
    promotion: promotion
      ? { number: promotion.number, title: promotion.title, mergedAt: promotion.merged_at, sha: promotion.merge_commit_sha }
      : null,
    ci: ci ? { conclusion: ci.conclusion, url: ci.html_url } : null,
    lab: lab
      ? {
          conclusion: lab.conclusion,
          url: lab.html_url,
          jobs: Object.fromEntries(jobs.map((j) => [j.name, j.conclusion])),
        }
      : null,
    milestones: milestones.map((m) => ({ number: m.number, title: m.title, open: m.open_issues, closed: m.closed_issues })),
    issues: issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        milestone: i.milestone?.number ?? null,
      })),
  }
}

// ---------------------------------------------------------------------------
// CLI

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

async function main() {
  const file = arg('--file', 'docs/agents/STATE.md')
  const repo = arg('--repo', process.env.GITHUB_REPOSITORY)
  if (!repo) throw new Error('No repository: pass --repo owner/name or set GITHUB_REPOSITORY')
  const before = readFileSync(file, 'utf8')
  const block = render(await fetchData(repo, token()))
  const after = replaceBlock(before, block)
  const changed = after !== before
  if (changed) writeFileSync(file, after)
  console.log(block)
  console.log(`\n${file}: ${changed ? 'changed' : 'unchanged'}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## STATE.md: ${changed ? 'changed' : 'unchanged'}\n\nGenerated block:\n\n\`\`\`markdown\n${block}\n\`\`\`\n`,
    )
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err?.stack ?? err)
    process.exit(1)
  })
}
