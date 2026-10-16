// Commit attribution check (#580). Agents commit from the owner's account,
// so the only record of who wrote a commit is a `Co-Authored-By: Name
// <email>` trailer. On a PR from this repository whose head branch has an
// agent branch prefix (BRANCH_PREFIXES), every commit needs that trailer,
// unless the PR has the label `human-only`. Commits GitHub makes in its web
// UI (merge button, "Update branch", web edits; committer GitHub
// <noreply@github.com>) are exempt: no agent makes them. Workflow:
// .github/workflows/attribution.yml; rules: docs/agents/github-workflow.md.
//
// Plain Node, no dependencies, one file: the workflow copies the base
// commit's version of this file alone to a temp dir when there is one, so it
// must not import sibling modules.

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Head branch prefixes of agent work (github-workflow.md, Branches). */
export const BRANCH_PREFIXES = ['fix/', 'ci/', 'docs/', 'feat/', 'chore/', 'test/']

/** A PR with this label is human work: no trailer is required. */
export const EXEMPT_LABEL = 'human-only'

/** The committer GitHub uses for commits made in its web UI. */
const WEB_FLOW_EMAIL = 'noreply@github.com'

/** The pulls/{n}/commits endpoint returns at most this many commits. */
export const MAX_COMMITS = 250

const TRAILER = /^([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*:[ \t]*(\S.*)$/
const CO_AUTHOR_VALUE = /^[^<>]*\S[^<>]*<[^<>\s@]+@[^<>\s@]+>$/

/**
 * The trailers of a commit message: [{ key, value }] from its last
 * paragraph, when that paragraph is not the subject paragraph and every
 * line in it is a `Key: value` line or an indented continuation (as git
 * reads them). Comment lines (`#`) are ignored.
 */
export function trailers(message) {
  const paragraphs = String(message ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim()
    .split(/\n(?:[ \t]*\n)+/)
  if (paragraphs.length < 2) return []
  const lines = paragraphs[paragraphs.length - 1].split('\n')
  const out = []
  for (const line of lines) {
    if (/^[ \t]+\S/.test(line) && out.length > 0) {
      out[out.length - 1].value += ` ${line.trim()}`
      continue
    }
    const m = TRAILER.exec(line.trimEnd())
    if (!m) return []
    out.push({ key: m[1], value: m[2].trim() })
  }
  return out
}

/** Whether a message has a `Co-Authored-By: Name <email>` trailer. */
export function hasCoAuthor(message) {
  return trailers(message).some(
    (t) => t.key.toLowerCase() === 'co-authored-by' && CO_AUTHOR_VALUE.test(t.value),
  )
}

/** Whether GitHub made the commit in its web UI (an API commit object). */
export function isWebFlow(commit) {
  return (
    commit?.committer?.login === 'web-flow' ||
    commit?.commit?.committer?.email?.toLowerCase() === WEB_FLOW_EMAIL
  )
}

/**
 * Whether the rule applies to a PR: { applies, reason }. It applies to PRs
 * from this repository whose head branch starts with an agent prefix and
 * that do not carry EXEMPT_LABEL.
 */
export function appliesTo(pr, repo) {
  const branch = pr?.head?.ref ?? ''
  const headRepo = pr?.head?.repo?.full_name
  if (headRepo && headRepo !== repo) {
    return { applies: false, reason: `the head branch is in \`${headRepo}\`, not this repository` }
  }
  const prefix = BRANCH_PREFIXES.find((p) => branch.startsWith(p))
  if (!prefix) {
    return {
      applies: false,
      reason:
        `the head branch \`${branch}\` does not start with ` +
        BRANCH_PREFIXES.map((p) => `\`${p}\``).join(', '),
    }
  }
  const labels = (pr.labels ?? []).map((l) => l.name)
  if (labels.includes(EXEMPT_LABEL)) {
    return { applies: false, reason: `the PR has the label \`${EXEMPT_LABEL}\`` }
  }
  return { applies: true, reason: `the head branch \`${branch}\` starts with \`${prefix}\`` }
}

const subject = (c) => String(c?.commit?.message ?? '').split('\n')[0]
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

/**
 * The verdict for a PR and its commits (API commit objects, oldest first):
 * { ok, skipped, missing, webFlow, title, report }. `missing` and
 * `webFlow` list { sha, subject }.
 */
export function check(pr, commits, repo) {
  const scope = appliesTo(pr, repo)
  if (!scope.applies) {
    return {
      ok: true,
      skipped: true,
      missing: [],
      webFlow: [],
      title: 'No trailer required.',
      report: `Skipped: ${scope.reason}.`,
    }
  }
  const total = pr.commits ?? commits.length
  if (total > commits.length) {
    return {
      ok: false,
      skipped: false,
      missing: [],
      webFlow: [],
      title: `The PR has ${total} commits; only ${commits.length} could be read.`,
      report:
        `GitHub lists at most ${MAX_COMMITS} commits of a PR, so this check cannot see them all. ` +
        'Split the PR or squash its commits.',
    }
  }
  const missing = []
  const webFlow = []
  for (const c of commits) {
    const row = { sha: c.sha, subject: subject(c) }
    if (isWebFlow(c)) webFlow.push(row)
    else if (!hasCoAuthor(c.commit?.message)) missing.push(row)
  }
  const ok = missing.length === 0
  const parts = [`Applies: ${scope.reason}.`]
  if (!ok) {
    parts.push(
      `${missing.length} of ${commits.length} commit(s) have no \`Co-Authored-By: Name <email>\` ` +
        'trailer in their last paragraph. Agents add one to every commit (for example ' +
        '`Co-Authored-By: Claude Opus <noreply@anthropic.com>`); fix with `git commit --amend` ' +
        'or `git rebase -i` and force-push. A PR written by a person gets the label ' +
        `\`${EXEMPT_LABEL}\` instead.\n\n| Commit | Subject |\n| --- | --- |\n` +
        missing.map((m) => `| ${m.sha.slice(0, 12)} | ${cell(m.subject)} |`).join('\n'),
    )
  }
  if (webFlow.length > 0) {
    parts.push(
      `Exempt, made in GitHub's web UI: ` +
        webFlow.map((m) => `${m.sha.slice(0, 12)} (${cell(m.subject)})`).join(', ') +
        '.',
    )
  }
  return {
    ok,
    skipped: false,
    missing,
    webFlow,
    title: ok
      ? `Every commit carries a Co-Authored-By trailer (${commits.length - webFlow.length} checked).`
      : 'Commits without a Co-Authored-By trailer.',
    report: parts.join('\n\n'),
  }
}

// ---------------------------------------------------------------------------
// Runner (GitHub Actions only)

// The workflow runs the base commit's copy of this script when the base
// has one (so a PR cannot edit the check it is judged by) and says which.
const CHECKER =
  process.env.ATTRIBUTION_CHECKER === 'base'
    ? "Checker: the base commit's `.github/scripts/attribution.mjs`."
    : process.env.ATTRIBUTION_CHECKER === 'pr'
      ? "Checker: the PR's `.github/scripts/attribution.mjs` (the base commit has none yet)."
      : ''

function finish(ok, title, body) {
  const markdown =
    `## Commit attribution: ${ok ? 'passed' : 'failed'}\n\n**${title}**` +
    (body ? `\n\n${body}` : '') +
    (CHECKER ? `\n\n${CHECKER}` : '')
  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  }
  if (!ok) console.log(`::error title=Commit attribution failed::${title}`)
  process.exit(ok ? 0 : 1)
}

async function prCommits(repo, number) {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const out = []
  for (let page = 1; out.length < MAX_COMMITS; page++) {
    const url = `${api}/repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    })
    if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`)
    const data = await res.json()
    out.push(...data)
    if (data.length < 100) break
  }
  return out
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const pr = event.pull_request
  if (!pr) finish(true, 'Not a pull_request event; nothing to check.', '')
  const repo = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY
  const scope = appliesTo(pr, repo)
  const commits = scope.applies ? await prCommits(repo, pr.number) : []
  const r = check(pr, commits, repo)
  finish(r.ok, r.title, r.report)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) =>
    finish(false, 'The check could not run.', `\`\`\`\n${err?.stack ?? err}\n\`\`\``),
  )
}
