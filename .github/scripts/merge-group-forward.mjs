// Forward a PR-level check to the merge queue. Required checks must also
// report on `merge_group` events (the queue's temporary commit), but checks
// that judge the PR itself (fails-before, attribution: title, labels, body,
// commits) have nothing new to judge there. On a `merge_group` event this
// script resolves the PR from the queue branch (`gh-readonly-queue/dev/pr-<N>-<sha>`),
// refuses unless the PR's live head is the commit the queue merged
// (MERGE_GROUP_PR_HEAD, the queue commit's second parent), waits up to
// WAIT_MS for the latest run of the same check on that head to complete
// (a body or label edit right after enqueue re-runs it) and re-applies its
// conclusion: pass when that run passed (or was skipped), fail otherwise,
// with a link to the run that decided.
//
// Plain Node, no dependencies, one file: the workflow copies the base
// commit's version of this file alone to a temp dir when there is one, so it
// must not import sibling modules. Usage, from a workflow step:
//   MERGE_GROUP_CHECK=<check name> MERGE_GROUP_PR_HEAD=$(git rev-parse HEAD^2) \
//     GITHUB_TOKEN=... node merge-group-forward.mjs

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Conclusions of a PR-level run the merge queue may inherit as passing. */
export const PASSING = new Set(['success', 'skipped', 'neutral'])

/** How long to wait for a PR-level run that is still queued or running. */
export const WAIT_MS = 180_000
export const POLL_MS = 15_000

const QUEUE_REF =
  /^(?:refs\/heads\/)?gh-readonly-queue\/[^/]+(?:\/[^/]+)*\/pr-(\d+)-[0-9a-f]{7,40}$/

/** The PR number a merge-queue head ref names, or null. */
export function prNumberFromHeadRef(ref) {
  const m = QUEUE_REF.exec(String(ref ?? '').trim())
  return m ? Number(m[1]) : null
}

/**
 * The run to forward among the check runs of a commit (API objects): the
 * newest (highest id) GitHub Actions run named `name`, or null.
 */
export function pickCheckRun(runs, name) {
  let best = null
  for (const r of runs ?? []) {
    if (r?.name !== name) continue
    if (r.app?.slug && r.app.slug !== 'github-actions') continue
    if (!best || (r.id ?? 0) > (best.id ?? 0)) best = r
  }
  return best
}

const short = (sha) => String(sha ?? '').slice(0, 12)

/**
 * Refuses to forward unless the PR's live head (`liveHead`) is the commit
 * the queue merged (`queuedHead`, the queue commit's second parent): a
 * verdict { ok: false, title, body }, or null when they match.
 */
export function headMismatch(queuedHead, liveHead, ctx) {
  if (!queuedHead) {
    return {
      ok: false,
      title: `Cannot identify the PR head inside the queue commit for PR #${ctx.pr}.`,
      body:
        "MERGE_GROUP_PR_HEAD (the queue commit's second parent, `HEAD^2`) is empty, so the " +
        'PR-level result cannot be matched to what the queue merged. Nothing is forwarded.',
    }
  }
  if (String(queuedHead).toLowerCase() !== String(liveHead).toLowerCase()) {
    return {
      ok: false,
      title: `PR #${ctx.pr} head is \`${short(liveHead)}\` but the queue merged \`${short(queuedHead)}\`.`,
      body:
        'The PR moved after it was queued; its check results belong to another commit. ' +
        'Nothing is forwarded: re-queue the PR.',
    }
  }
  return null
}

/**
 * Waits for the PR-level run to complete: calls `fetchRun()` (the newest
 * run, or null) every `pollMs` until it is completed or `waitMs` has
 * passed, and returns the last run seen. `sleep` and `now` are injectable
 * for tests.
 */
export async function awaitRun(
  fetchRun,
  {
    waitMs = WAIT_MS,
    pollMs = POLL_MS,
    sleep = defaultSleep,
    now = Date.now,
    log = () => {},
  } = {},
) {
  const deadline = now() + waitMs
  let run = await fetchRun()
  while ((!run || run.status !== 'completed') && now() < deadline) {
    log(
      `PR-level run ${run ? run.status : 'not found yet'}; waiting ${pollMs / 1000}s`,
    )
    await sleep(pollMs)
    run = await fetchRun()
  }
  return run
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The merge-group verdict for a PR-level run: { ok, title, body }. `ctx`
 * names the check, the PR number and the PR head sha for the messages.
 */
export function forward(run, ctx) {
  const where = `PR #${ctx.pr} head \`${short(ctx.headSha)}\``
  if (!run) {
    return {
      ok: false,
      title: `No \`${ctx.check}\` run on ${where}.`,
      body:
        `The merge queue inherits this check from the PR, but the PR head has no \`${ctx.check}\` ` +
        'check run. Re-run the PR checks (push, or re-run the workflow on the PR) and re-queue.',
    }
  }
  const link = run.html_url ? ` ([run](${run.html_url}))` : ''
  if (run.status !== 'completed') {
    return {
      ok: false,
      title: `\`${ctx.check}\` on ${where} is still ${run.status} after ${WAIT_MS / 1000}s${link}.`,
      body: 'Wait for the PR-level run to finish, then re-queue the PR.',
    }
  }
  if (PASSING.has(run.conclusion)) {
    return {
      ok: true,
      title: `Forwarded: \`${ctx.check}\` on ${where} concluded \`${run.conclusion}\`${link}.`,
      body: 'The queue commit inherits the PR-level result; nothing is re-judged here.',
    }
  }
  return {
    ok: false,
    title: `\`${ctx.check}\` on ${where} concluded \`${run.conclusion}\`${link}.`,
    body: 'Fix the PR so its own check passes, then re-queue it.',
  }
}

// ---------------------------------------------------------------------------
// Runner (GitHub Actions only)

const CHECKER =
  process.env.MERGE_GROUP_CHECKER === 'base'
    ? "Checker: the base commit's `.github/scripts/merge-group-forward.mjs`."
    : process.env.MERGE_GROUP_CHECKER === 'pr'
      ? "Checker: the PR's `.github/scripts/merge-group-forward.mjs` (the base commit has none yet)."
      : ''

function finish(check, ok, title, body) {
  const markdown =
    `## ${check} (merge queue): ${ok ? 'passed' : 'failed'}\n\n**${title}**` +
    (body ? `\n\n${body}` : '') +
    (CHECKER ? `\n\n${CHECKER}` : '')
  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  }
  if (!ok) console.log(`::error title=${check} (merge queue) failed::${title}`)
  process.exit(ok ? 0 : 1)
}

async function api(path) {
  const base = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const url = `${base}${path}`
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  })
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function main() {
  const check = process.env.MERGE_GROUP_CHECK
  if (!check)
    throw new Error('MERGE_GROUP_CHECK (the check name to forward) is not set')
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const group = event.merge_group
  if (!group)
    finish(check, true, 'Not a merge_group event; nothing to forward.', '')
  const repo = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY
  const number = prNumberFromHeadRef(group.head_ref)
  if (number === null) {
    finish(
      check,
      false,
      `Cannot read a PR number from the queue ref \`${group.head_ref}\`.`,
      '',
    )
  }
  const pr = await api(`/repos/${repo}/pulls/${number}`)
  const headSha = pr.head.sha
  const ctx = { check, pr: number, headSha }
  const mismatch = headMismatch(
    process.env.MERGE_GROUP_PR_HEAD?.trim(),
    headSha,
    ctx,
  )
  if (mismatch) finish(check, false, mismatch.title, mismatch.body)
  const fetchRun = async () => {
    const runs = []
    for (let page = 1; page < 10; page++) {
      const data = await api(
        `/repos/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(check)}&per_page=100&page=${page}`,
      )
      runs.push(...(data.check_runs ?? []))
      if ((data.check_runs ?? []).length < 100) break
    }
    return pickCheckRun(runs, check)
  }
  const run = await awaitRun(fetchRun, { log: console.log })
  const v = forward(run, ctx)
  finish(check, v.ok, v.title, v.body)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) =>
    finish(
      process.env.MERGE_GROUP_CHECK ?? 'merge-group-forward',
      false,
      'The check could not run.',
      `\`\`\`\n${err?.stack ?? err}\n\`\`\``,
    ),
  )
}
