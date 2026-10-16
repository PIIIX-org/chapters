// Review gate for promotions (#574). Sets a commit status on a PR's current
// head: success only when someone with write access reviewed exactly what
// is about to merge, shown by either
//   - an approving GitHub review on the head commit by someone other than
//     the PR author, or
//   - a PR comment whose first line is `VERDICT: MERGE`, posted after the
//     head became the head, that names the head (`Head reviewed: <sha>`) and
//     links the review record.
// A status belongs to a commit, not to a PR, so it is set only for PRs from
// this repository to a base listed in CONTEXTS (each base its own context).
// Two PRs with the same base and the same head have the same diff, so a
// review of one is a review of the other. Workflow:
// .github/workflows/review-verdict.yml; rules and caveats:
// docs/agents/github-workflow.md (Branch protection and the review gate).
//
// Plain Node, no dependencies, one file: the workflow copies the base
// commit's version of this file alone to a temp dir when there is one, so it
// must not import sibling modules.

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * The status context set for PRs to each base. `review-verdict` is required
 * on `prod`; `review-verdict/dev` only reports. Any other base gets no
 * status: a verdict on a PR to `lab/*` must not mark the same commit as
 * reviewed for a promotion.
 */
export const CONTEXTS = new Map([
  ['prod', 'review-verdict'],
  ['dev', 'review-verdict/dev'],
  // SCRATCH ONLY (#574 proof 3, never merged): gate the scratch copy of prod.
  ['lab/protect-demo', 'review-verdict'],
])

/**
 * Repository permissions that can give a verdict, as returned in
 * `permission` by GET /repos/{o}/{r}/collaborators/{user}/permission
 * (`maintain` is reported as `write` there, `triage` as `read`).
 */
export const WRITE_PERMISSIONS = new Set(['admin', 'write'])

const VERDICT = /^VERDICT: (MERGE|CHANGES)$/
const HEAD_REVIEWED = /^[ \t]*Head reviewed:[ \t]*`?([0-9a-fA-F]{12,40})`?[ \t]*$/m

/**
 * 'MERGE', 'CHANGES' or null. The first line of the comment (leading blank
 * lines skipped, surrounding spaces trimmed) must be exactly
 * `VERDICT: MERGE` or `VERDICT: CHANGES`.
 */
export function verdictOf(body) {
  const line = String(body ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .find((l) => l.trim() !== '')
  const m = VERDICT.exec(line?.trim() ?? '')
  return m ? m[1] : null
}

/**
 * The commit a verdict names on its own `Head reviewed: <sha>` line (12 to
 * 40 hex digits, optionally in backticks), lower-cased, or null.
 */
export function headReviewed(body) {
  const m = HEAD_REVIEWED.exec(String(body ?? '').replace(/\r\n/g, '\n'))
  return m ? m[1].toLowerCase() : null
}

/** The status context for PRs to `base`, or null when the base is not gated. */
export function contextFor(base) {
  return CONTEXTS.get(base) ?? null
}

/**
 * Whether a PR gets a status: { context } or { skip: reason }. A fork PR
 * never does: its head can be a promotion's head (dev's tip), and a status
 * set for it would land on the promotion's commit.
 */
export function gateFor(pr, repo) {
  if (pr.head?.repo?.full_name !== repo)
    return { skip: `PR #${pr.number} comes from ${pr.head?.repo?.full_name ?? 'a deleted fork'}; fork PRs get no status.` }
  const context = contextFor(pr.base?.ref)
  if (!context) return { skip: `PR #${pr.number} targets \`${pr.base?.ref}\`, which has no review gate; no status set.` }
  if (pr.state !== 'open') return { skip: `PR #${pr.number} is ${pr.state}; no status set.` }
  return { context }
}

/**
 * The review-record links in a comment: `http(s)://` URLs and Elara
 * `[[path]]` links. Links to the PR itself (`prUrl`, its tabs and anchors)
 * are not a record of the review.
 */
export function reviewLinks(body, prUrl = '') {
  const text = String(body ?? '')
  const urls = [...text.matchAll(/https?:\/\/[^\s<>()\]]+/g)]
    .map((m) => m[0].replace(/[.,;:!?'"`*_]+$/, ''))
    .filter((u) => !prUrl || !isSamePage(u, prUrl))
  const notes = [...text.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((m) => `[[${m[1]}]]`)
  return [...urls, ...notes]
}

function isSamePage(url, prUrl) {
  const base = prUrl.replace(/\/+$/, '')
  return url === base || (url.startsWith(base) && /^[/#?]/.test(url.slice(base.length)))
}

const time = (iso) => {
  const t = Date.parse(iso ?? '')
  return Number.isNaN(t) ? null : t
}

/**
 * When the current head became the head: the latest of the head commit's
 * committer date, the first check suite GitHub created for that SHA (its
 * push, which a backdated commit cannot hide) and the last force-push of
 * the PR branch (a force-push back to an older, already-seen commit).
 * Returns { at: ms | null, source }.
 */
export function headSince({ commitDate, firstSeen, forcePushed }) {
  const candidates = [
    ['commit date', time(commitDate)],
    ['first seen', time(firstSeen)],
    ['force-push', time(forcePushed)],
  ].filter(([, t]) => t !== null)
  if (candidates.length === 0) return { at: null, source: 'unknown' }
  const [source, at] = candidates.reduce((a, b) => (b[1] > a[1] ? b : a))
  return { at, source }
}

const short = (sha) => String(sha ?? '').slice(0, 7)
const iso = (ms) => (ms === null ? 'unknown' : new Date(ms).toISOString())

/**
 * The verdict for a PR.
 *
 *   pr        GET /pulls/{n} (user.login, head.sha, base.ref, html_url)
 *   reviews   GET /pulls/{n}/reviews (user, state, commit_id, submitted_at)
 *   comments  GET /issues/{n}/comments (user, body, created_at, html_url)
 *   since     headSince(...)
 *   writers   logins whose repository permission is in WRITE_PERMISSIONS
 *   lookupFailed  logins whose permission could not be read (not counted)
 *
 * Returns { ok, description (status text, <= 140 chars), report (markdown) }.
 */
export function evaluate({ pr, reviews = [], comments = [], since, writers = new Set(), lookupFailed = new Set() }) {
  const author = pr.user?.login
  const head = pr.head?.sha
  const lines = []
  const person = (u) => Boolean(u?.login) && u.type !== 'Bot'
  const counts = (u) => person(u) && writers.has(u.login)

  // Reviews: each other writer's latest decisive review.
  const latest = new Map()
  const decisive = [...reviews]
    .filter((r) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .sort((a, b) => (time(a.submitted_at) ?? 0) - (time(b.submitted_at) ?? 0))
  for (const r of decisive) {
    if (!counts(r.user) || r.user.login === author) continue
    latest.set(r.user.login, r)
  }
  const changesRequested = [...latest.values()].filter((r) => r.state === 'CHANGES_REQUESTED')
  const approvals = [...latest.values()].filter((r) => r.state === 'APPROVED' && r.commit_id === head)
  const staleApprovals = [...latest.values()].filter((r) => r.state === 'APPROVED' && r.commit_id !== head)

  // Comments: verdicts from writers, split at the moment the head appeared.
  const found = comments
    .map((c) => ({ c, verdict: verdictOf(c.body), at: time(c.created_at) }))
    .filter((v) => v.verdict && v.at !== null)
    .sort((a, b) => a.at - b.at)
  const ignored = found.filter((v) => !counts(v.c.user))
  const verdicts = found.filter((v) => counts(v.c.user))
  const current = since.at === null ? [] : verdicts.filter((v) => v.at > since.at)
  const stale = verdicts.filter((v) => !current.includes(v))
  const last = current.at(-1)

  lines.push(
    `Head \`${short(head)}\`, the head since ${iso(since.at)} (${since.source}). Base \`${pr.base?.ref}\`. PR author: @${author}.`,
    '',
  )
  for (const r of approvals) lines.push(`- Approved on the head by @${r.user.login}.`)
  for (const r of staleApprovals)
    lines.push(`- Approval by @${r.user.login} is on \`${short(r.commit_id)}\`, not the head: does not count.`)
  for (const r of changesRequested) lines.push(`- Changes requested by @${r.user.login} (latest review).`)
  const why = (u) =>
    !person(u) ? 'a bot' : lookupFailed.has(u.login) ? 'permission lookup failed' : 'no write access'
  for (const v of ignored)
    lines.push(`- \`VERDICT: ${v.verdict}\` by @${v.c.user?.login} ignored: ${why(v.c.user)} (${v.c.html_url}).`)
  for (const v of stale)
    lines.push(
      `- \`VERDICT: ${v.verdict}\` by @${v.c.user?.login} at ${v.c.created_at} predates the head: does not count (${v.c.html_url}).`,
    )
  for (const v of current)
    lines.push(`- \`VERDICT: ${v.verdict}\` by @${v.c.user?.login} at ${v.c.created_at} (${v.c.html_url}).`)
  if (lines.length === 2) lines.push('- No approving review and no `VERDICT:` comment.')

  const done = (ok, description) => ({
    ok,
    description: description.length > 140 ? `${description.slice(0, 139)}…` : description,
    report: [...lines, '', ok ? '' : HOW_TO(head)].join('\n').trim(),
  })

  if (changesRequested.length)
    return done(false, `Changes requested by @${changesRequested.map((r) => r.user.login).join(', @')}`)
  if (last?.verdict === 'CHANGES')
    return done(false, `Latest verdict after ${short(head)} is VERDICT: CHANGES (@${last.c.user?.login})`)
  if (approvals.length) return done(true, `Approved on ${short(head)} by @${approvals[0].user.login}`)
  if (last?.verdict === 'MERGE') {
    const who = `@${last.c.user?.login}`
    const named = headReviewed(last.c.body)
    if (!named) return done(false, `VERDICT: MERGE by ${who} has no "Head reviewed: <sha>" line`)
    if (!String(head).toLowerCase().startsWith(named))
      return done(false, `VERDICT: MERGE by ${who} names ${named.slice(0, 7)}, not the head ${short(head)}`)
    const links = reviewLinks(last.c.body, pr.html_url)
    if (links.length === 0) return done(false, `VERDICT: MERGE by ${who} links no review record`)
    lines.push('', `Review record: ${links[0]}`)
    return done(true, `VERDICT: MERGE by ${who} on ${short(head)}`)
  }
  if (stale.some((v) => v.verdict === 'MERGE') || staleApprovals.length)
    return done(false, `Review predates head ${short(head)}: review the new commits, post the verdict again`)
  return done(false, `No review of ${short(head)}: post VERDICT: MERGE with the head and a review link, or approve`)
}

const HOW_TO = (head) =>
  [
    '**How to pass.** Review the PR at its head (`' + head + '`), then either',
    '- approve it on GitHub from an account other than the PR author, or',
    '- post a PR comment whose first line is exactly `VERDICT: MERGE`, with a line `Head reviewed: ' +
      head +
      '` (the head, at least 12 of its hex digits) and a link to the review record (an `https://` URL or an Elara `[[reviews/...]]` link). A comment posted before the latest push does not count: re-review and post again.',
    '',
    'The latest verdict comment decides: a `VERDICT: CHANGES` stays red until a later `VERDICT: MERGE` comment replaces it. Only users with admin, maintain or write permission on the repository count; bots never do. Rules: `docs/agents/github-workflow.md` (Branch protection and the review gate).',
  ].join('\n')

// ---------------------------------------------------------------------------
// Runner (GitHub Actions only)

const CHECKER =
  process.env.REVIEW_VERDICT_CHECKER === 'base'
    ? "Checker: the base commit's `.github/scripts/review-verdict.mjs`."
    : process.env.REVIEW_VERDICT_CHECKER === 'pr'
      ? "Checker: the PR's `.github/scripts/review-verdict.mjs` (the base commit has none yet)."
      : process.env.REVIEW_VERDICT_CHECKER === 'default'
        ? "Checker: the default branch's `.github/scripts/review-verdict.mjs` (comment events run from it)."
        : ''

function summary(markdown) {
  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

async function api(path, { method = 'GET', body } = {}) {
  const url = path.startsWith('https://') ? path : `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`
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
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`)
  return { data: await res.json(), next: /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] }
}

async function all(path, pick = (d) => d) {
  const out = []
  for (let next = path; next; ) {
    const page = await api(next)
    out.push(...pick(page.data))
    next = page.next
  }
  return out
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const repo = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY
  const number = event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : null)
  if (!number) return summary('Not a pull request; nothing to check.')

  const r = `/repos/${repo}`
  const { data: pr } = await api(`${r}/pulls/${number}`)
  const gate = gateFor(pr, repo)
  if (gate.skip) return summary(gate.skip)
  const { context } = gate
  const head = pr.head.sha

  const [reviews, comments, commit, suites, timeline] = await Promise.all([
    all(`${r}/pulls/${number}/reviews?per_page=100`),
    all(`${r}/issues/${number}/comments?per_page=100`),
    api(`${r}/commits/${head}`).then((x) => x.data),
    all(`${r}/commits/${head}/check-suites?per_page=100`, (d) => d.check_suites),
    all(`${r}/issues/${number}/timeline?per_page=100`),
  ])
  const minIso = (xs) => xs.filter(Boolean).sort((a, b) => time(a) - time(b))[0]
  const maxIso = (xs) => xs.filter(Boolean).sort((a, b) => time(b) - time(a))[0]
  const since = headSince({
    commitDate: commit.commit?.committer?.date,
    firstSeen: minIso(suites.map((s) => s.created_at)),
    forcePushed: maxIso(timeline.filter((e) => e.event === 'head_ref_force_pushed').map((e) => e.created_at)),
  })

  // Write access is the repository permission, not author_association:
  // MEMBER is any org member and COLLABORATOR includes read and triage.
  const logins = new Set(
    [...reviews.map((x) => x.user), ...comments.filter((c) => verdictOf(c.body)).map((c) => c.user)]
      .filter((u) => u?.login && u.type !== 'Bot')
      .map((u) => u.login),
  )
  const writers = new Set()
  const lookupFailed = new Set()
  const permissions = []
  for (const login of logins) {
    try {
      const { data } = await api(`${r}/collaborators/${encodeURIComponent(login)}/permission`)
      if (WRITE_PERMISSIONS.has(data.permission)) writers.add(login)
      permissions.push(`@${login}: ${data.permission}${data.role_name ? ` (${data.role_name})` : ''}`)
    } catch (err) {
      lookupFailed.add(login)
      permissions.push(`@${login}: lookup failed, not counted (${String(err.message).slice(0, 120)})`)
    }
  }

  const v = evaluate({ pr, reviews, comments, since, writers, lookupFailed })
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
  await api(`${r}/statuses/${head}`, {
    method: 'POST',
    body: { state: v.ok ? 'success' : 'failure', context, description: v.description, target_url: runUrl },
  })
  summary(
    [
      `## Review verdict for #${number}: ${v.ok ? 'passed' : 'failed'}`,
      '',
      `**${v.description}**`,
      '',
      `Status \`${context}\` set to ${v.ok ? 'success' : 'failure'} on \`${head}\` (base \`${pr.base.ref}\`).`,
      '',
      v.report,
      '',
      `Permissions: ${permissions.length ? permissions.join('; ') : 'no reviewer or verdict author to check'}.`,
      ...(CHECKER ? ['', CHECKER] : []),
    ].join('\n'),
  )
  if (!v.ok) console.log(`::notice title=${context}: failure::${v.description}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    summary(`## Review verdict: the check could not run\n\n\`\`\`\n${err?.stack ?? err}\n\`\`\``)
    console.log('::error title=review-verdict could not run::no status was set; a required check stays pending')
    process.exit(1)
  })
}
