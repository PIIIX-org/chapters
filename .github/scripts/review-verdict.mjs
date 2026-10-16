// Review gate for promotions (#574). Sets the commit status `review-verdict`
// on a PR's current head: success only when someone reviewed exactly what
// is about to merge, shown by either
//   - an approving GitHub review on the head commit by someone other than
//     the PR author, or
//   - a PR comment whose first line is `VERDICT: MERGE`, posted after the
//     head became the head, that links the review record.
// Required on `prod`; informational on every other base. Workflow:
// .github/workflows/review-verdict.yml; rules and the single-account
// caveat: docs/agents/github-workflow.md (Review gate).
//
// Plain Node, no dependencies, one file: the workflow copies the base
// commit's version of this file alone to a temp dir when there is one, so it
// must not import sibling modules.

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The status context branch protection requires on `prod`. */
export const CONTEXT = 'review-verdict'

/**
 * Who can give a verdict: users with write access. Anyone can comment on
 * or review a public repo's PR; their verdicts never count.
 */
export const WRITE_ACCESS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

const VERDICT = /^VERDICT: (MERGE|CHANGES)$/

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
 *   pr        GET /pulls/{n} (user.login, head.sha, html_url)
 *   reviews   GET /pulls/{n}/reviews (user, state, commit_id, submitted_at,
 *             author_association)
 *   comments  GET /issues/{n}/comments (user, body, created_at,
 *             author_association, html_url)
 *   since     headSince(...)
 *
 * Returns { ok, description (status text, <= 140 chars), report (markdown) }.
 */
export function evaluate({ pr, reviews = [], comments = [], since }) {
  const author = pr.user?.login
  const head = pr.head?.sha
  const lines = []

  // Reviews: each other writer's latest decisive review.
  const latest = new Map()
  const decisive = [...reviews]
    .filter((r) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .sort((a, b) => (time(a.submitted_at) ?? 0) - (time(b.submitted_at) ?? 0))
  for (const r of decisive) {
    const who = r.user?.login
    if (!who || who === author) continue
    if (!WRITE_ACCESS.has(r.author_association)) continue
    latest.set(who, r)
  }
  const changesRequested = [...latest.values()].filter((r) => r.state === 'CHANGES_REQUESTED')
  const approvals = [...latest.values()].filter((r) => r.state === 'APPROVED' && r.commit_id === head)
  const staleApprovals = [...latest.values()].filter((r) => r.state === 'APPROVED' && r.commit_id !== head)

  // Comments: verdicts from writers, split at the moment the head appeared.
  const verdicts = comments
    .filter((c) => c.user?.type !== 'Bot' && WRITE_ACCESS.has(c.author_association))
    .map((c) => ({ c, verdict: verdictOf(c.body), at: time(c.created_at) }))
    .filter((v) => v.verdict && v.at !== null)
    .sort((a, b) => a.at - b.at)
  const current = since.at === null ? [] : verdicts.filter((v) => v.at > since.at)
  const stale = verdicts.filter((v) => !current.includes(v))
  const last = current.at(-1)
  const lastLinks = last ? reviewLinks(last.c.body, pr.html_url) : []

  lines.push(
    `Head \`${short(head)}\`, the head since ${iso(since.at)} (${since.source}). PR author: @${author}.`,
    '',
  )
  for (const r of approvals) lines.push(`- Approved on the head by @${r.user.login}.`)
  for (const r of staleApprovals)
    lines.push(`- Approval by @${r.user.login} is on \`${short(r.commit_id)}\`, not the head: does not count.`)
  for (const r of changesRequested) lines.push(`- Changes requested by @${r.user.login} (latest review).`)
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
    report: [...lines, '', ok ? '' : HOW_TO(short(head))].join('\n').trim(),
  })

  if (changesRequested.length)
    return done(false, `Changes requested by @${changesRequested.map((r) => r.user.login).join(', @')}`)
  if (last?.verdict === 'CHANGES')
    return done(false, `Latest verdict after ${short(head)} is VERDICT: CHANGES (@${last.c.user?.login})`)
  if (approvals.length) return done(true, `Approved on ${short(head)} by @${approvals[0].user.login}`)
  if (last?.verdict === 'MERGE') {
    if (lastLinks.length === 0)
      return done(false, `VERDICT: MERGE by @${last.c.user?.login} links no review record`)
    lines.push('', `Review record: ${lastLinks[0]}`)
    return done(true, `VERDICT: MERGE by @${last.c.user?.login} after ${short(head)}`)
  }
  if (stale.some((v) => v.verdict === 'MERGE') || staleApprovals.length)
    return done(false, `Review predates head ${short(head)}: review the new commits, post the verdict again`)
  return done(false, `No review of ${short(head)}: post VERDICT: MERGE with a review link, or approve`)
}

const HOW_TO = (head) =>
  [
    '**How to pass.** Review the PR at its head (`' + head + '`), then either',
    '- approve it on GitHub from an account other than the PR author, or',
    '- post a PR comment whose first line is exactly `VERDICT: MERGE`, with a link to the review record (an `https://` URL or an Elara `[[reviews/...]]` link) below it. A comment posted before the latest push does not count: re-review and post again. `VERDICT: CHANGES` (first line) blocks until a later `VERDICT: MERGE` follows a fixing push.',
    '',
    'Only users with write access count. Rules: `docs/agents/github-workflow.md` (Review gate).',
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
  if (pr.state !== 'open') return summary(`PR #${number} is ${pr.state}; no status set.`)
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

  const v = evaluate({ pr, reviews, comments, since })
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
  await api(`${r}/statuses/${head}`, {
    method: 'POST',
    body: { state: v.ok ? 'success' : 'failure', context: CONTEXT, description: v.description, target_url: runUrl },
  })
  summary(
    [
      `## Review verdict for #${number}: ${v.ok ? 'passed' : 'failed'}`,
      '',
      `**${v.description}**`,
      '',
      `Status \`${CONTEXT}\` set to ${v.ok ? 'success' : 'failure'} on \`${head}\` (base \`${pr.base.ref}\`; required on \`prod\` only).`,
      '',
      v.report,
      ...(CHECKER ? ['', CHECKER] : []),
    ].join('\n'),
  )
  if (!v.ok) console.log(`::notice title=review-verdict: failure::${v.description}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    summary(`## Review verdict: the check could not run\n\n\`\`\`\n${err?.stack ?? err}\n\`\`\``)
    console.log('::error title=review-verdict could not run::no status was set; a required check stays pending')
    process.exit(1)
  })
}
