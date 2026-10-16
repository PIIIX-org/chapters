// Uptime monitor (#583). Reads an Elara instance's public `/health` (one
// read-only GET; monitoring, not testing) and compares the process identity
// it reports with the last one seen:
//   - `bootId` changed            -> restart alert (old/new startedAt,
//     version, lastShutdown); `lastShutdown: unclean` also labels the issue
//   - 2 failed checks in a row    -> one down alert
//   - answers again after a down  -> one recovered alert
// A payload without `bootId` (an image older than #583) is unknown: it is
// recorded, never compared, so it cannot alert in a loop.
//
// Two stores for the last-seen state:
//   - issue mode (the workflow, .github/workflows/uptime.yml): a hidden JSON
//     block in the body of the open issue titled ISSUE_TITLE with the label
//     ISSUE_LABEL; alerts are comments on it, which notify its subscribers.
//     The body is rewritten only when the state changes.
//   - file mode (`--state-file <path>`, the lab test): a JSON file; nothing
//     is posted.
// Either way the run prints one JSON line: the observation, the alerts and
// the comment it posted (or would post).
//
//   node .github/scripts/uptime-monitor.mjs [--url <base>] [--state-file <path>] [--dry-run]
//
// Docs: docs/agents/github-workflow.md (Production uptime monitor).
// Plain Node, no dependencies; also runs under bun (lab/tests/uptime-monitor.test.ts).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const DEFAULT_URL = 'https://chapters.piiix.org'
export const ISSUE_TITLE = 'Production uptime'
export const ISSUE_LABEL = 'owner'
export const UNCLEAN_LABEL = 'unclean-restart'
/** Consecutive failed checks before a down alert (one transient failure is not an outage). */
export const DOWN_AFTER = 2
const SHUTDOWN_KINDS = new Set(['graceful', 'unclean', 'unknown'])
const STATE_BLOCK = /<!-- uptime-state ([\s\S]*?) -->/

export function emptyState() {
  return {
    bootId: null,
    startedAt: null,
    version: null,
    lastShutdown: null,
    failures: 0,
    firstFailureAt: null,
    down: false,
  }
}

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null)

/**
 * One `/health` response -> observation. `status` and `body` are what came
 * back; `error` is set when nothing usable did (network error, timeout).
 * Up means HTTP 2xx and `status: 'ok'`; a 503 (database unreachable) is down.
 */
export function observe({ at, status = null, body = null, error = null }) {
  if (error) return { at, ok: false, error: String(error) }
  if (status === null || status < 200 || status >= 300) return { at, ok: false, error: `HTTP ${status}` }
  if (body?.status !== 'ok') return { at, ok: false, error: `status ${JSON.stringify(body?.status ?? null)}` }
  return {
    at,
    ok: true,
    health: {
      bootId: str(body.bootId),
      startedAt: str(body.startedAt),
      version: str(body.version),
      lastShutdown: SHUTDOWN_KINDS.has(body.lastShutdown) ? body.lastShutdown : null,
    },
  }
}

/**
 * The decision: previous state + observation -> next state + alerts.
 * Every alert fires once per event: a restart once per new bootId, down once
 * per outage (failures stop counting at DOWN_AFTER, so the state does not
 * change while it stays down), recovered once.
 */
export function step(prev, obs) {
  const p = { ...emptyState(), ...prev }
  const alerts = []
  if (!obs.ok) {
    const failures = Math.min(p.failures + 1, DOWN_AFTER)
    const firstFailureAt = p.firstFailureAt ?? obs.at
    const down = p.down || failures >= DOWN_AFTER
    if (down && !p.down) alerts.push({ kind: 'down', since: firstFailureAt, at: obs.at, error: obs.error })
    return { state: { ...p, failures, firstFailureAt, down }, alerts }
  }
  if (p.down) alerts.push({ kind: 'recovered', since: p.firstFailureAt, at: obs.at })
  const h = obs.health
  if (h.bootId && p.bootId && h.bootId !== p.bootId) {
    alerts.push({
      kind: 'restart',
      at: obs.at,
      previous: { bootId: p.bootId, startedAt: p.startedAt, version: p.version },
      current: { bootId: h.bootId, startedAt: h.startedAt, version: h.version },
      lastShutdown: h.lastShutdown ?? 'unknown',
    })
  }
  return {
    state: { ...emptyState(), bootId: h.bootId, startedAt: h.startedAt, version: h.version, lastShutdown: h.lastShutdown },
    alerts,
  }
}

/** Labels the alerts add to the issue. */
export function labelsFor(alerts) {
  return alerts.some((a) => a.kind === 'restart' && a.lastShutdown === 'unclean') ? [UNCLEAN_LABEL] : []
}

const SHUTDOWN_MEANING = {
  graceful: 'the previous process finished a clean SIGTERM/SIGINT shutdown (redeploy, `docker compose restart`, host reboot that stopped the container first)',
  unclean:
    'the previous process never finished a clean shutdown: crash, OOM kill, SIGKILL, uncaught exception, or a shutdown Docker cut short. Note edits inside the collab debounce may be lost; queued embedding and extraction work is re-queued by the boot catch-up',
  unknown: 'no lifecycle marker was found (first boot on this data directory, or the previous image predates #583)',
}

const code = (v) => (v ? `\`${v}\`` : '_none_')

function minutes(from, to) {
  const ms = Date.parse(to) - Date.parse(from)
  return Number.isFinite(ms) ? `${Math.max(0, Math.round(ms / 60_000))} min` : 'unknown'
}

/** Markdown for one comment holding every alert of a run. */
export function formatComment(alerts, url) {
  const parts = []
  for (const a of alerts) {
    if (a.kind === 'down') {
      parts.push(
        `### Down: ${url}`,
        '',
        `\`/health\` failed ${DOWN_AFTER} checks in a row, the first at ${a.since}. Last error: ${code(a.error)}. One more comment follows when it answers again.`,
      )
    } else if (a.kind === 'recovered') {
      parts.push(`### Recovered: ${url}`, '', `\`/health\` answers again at ${a.at}; down since ${a.since} (about ${minutes(a.since, a.at)}).`)
    } else if (a.kind === 'restart') {
      parts.push(
        `### Restart: ${url}`,
        '',
        '| | previous | current |',
        '|---|---|---|',
        `| startedAt | ${code(a.previous.startedAt)} | ${code(a.current.startedAt)} |`,
        `| version | ${code(a.previous.version)} | ${code(a.current.version)} |`,
        `| bootId | ${code(a.previous.bootId)} | ${code(a.current.bootId)} |`,
        '',
        `lastShutdown: **${a.lastShutdown}**: ${SHUTDOWN_MEANING[a.lastShutdown] ?? SHUTDOWN_MEANING.unknown}.`,
        ...(a.lastShutdown === 'unclean' ? ['', `Label \`${UNCLEAN_LABEL}\` added; remove it once this restart is explained.`] : []),
      )
    }
    parts.push('')
  }
  parts.push(`_Seen at ${alerts[0]?.at ?? ''} by the uptime monitor (\`.github/workflows/uptime.yml\`, #583)._`)
  return parts.join('\n')
}

/** The monitor's state block in an issue body -> `{ [url]: state }`. */
export function readStates(body) {
  const m = STATE_BLOCK.exec(body ?? '')
  if (!m) return {}
  try {
    const parsed = JSON.parse(m[1])
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Issue body with its state block replaced (or appended). `<`/`>` escaped so JSON cannot close the comment. */
export function writeStates(body, states) {
  const json = JSON.stringify(states).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  const block = `<!-- uptime-state ${json} -->`
  const base = body ?? ''
  return STATE_BLOCK.test(base) ? base.replace(STATE_BLOCK, () => block) : `${base.trimEnd()}\n\n${block}\n`
}

export function issueBody(url) {
  return [
    `Pinned issue of the uptime monitor (\`.github/workflows/uptime.yml\`, #583). Every 10 minutes it reads ${url}/health and comments here when:`,
    '',
    '- the app restarted (`bootId` changed): previous and current `startedAt`, `version`, and how the previous process ended (`lastShutdown`). An `unclean` restart also adds the label `unclean-restart`;',
    `- \`/health\` failed ${DOWN_AFTER} checks in a row (once per outage), and again when it answers.`,
    '',
    'Subscribe to this issue to be notified. How it works and how to change it: `docs/agents/github-workflow.md` (Production uptime monitor).',
    '',
    'The block below is the monitor\'s memory (last seen state per URL); do not edit it.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Runner

export function parseArgs(argv) {
  const args = { url: process.env.UPTIME_URL || DEFAULT_URL, stateFile: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') args.url = argv[++i]
    else if (a === '--state-file') args.stateFile = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!/^https?:\/\/[^/]/.test(args.url ?? '')) throw new Error(`--url must be an http(s) URL, got ${JSON.stringify(args.url)}`)
  args.url = args.url.replace(/\/+$/, '')
  return args
}

async function probe(url) {
  const at = new Date().toISOString()
  try {
    const res = await fetch(`${url}/health`, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': 'elara-uptime-monitor (#583)' },
      signal: AbortSignal.timeout(15_000),
    })
    let body = null
    try {
      body = await res.json()
    } catch {
      /* not JSON: observe() reports the status */
    }
    return observe({ at, status: res.status, body })
  } catch (err) {
    return observe({ at, error: err?.cause?.code ?? err?.message ?? err })
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const url = `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`
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
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * The open monitor issue, created (labelled ISSUE_LABEL) when there is none.
 * A dry run creates nothing and starts from an empty state.
 */
async function monitorIssue(repo, url, dryRun) {
  const issues = await api(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(ISSUE_LABEL)}&per_page=100`)
  const found = issues.find((i) => !i.pull_request && i.title === ISSUE_TITLE)
  if (found) return found
  if (dryRun) return { number: null, body: '', html_url: `(no open "${ISSUE_TITLE}" issue labelled ${ISSUE_LABEL}; a real run creates it)` }
  return api(`/repos/${repo}/issues`, {
    method: 'POST',
    body: { title: ISSUE_TITLE, labels: [ISSUE_LABEL], body: writeStates(issueBody(url), {}) },
  })
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const obs = await probe(args.url)
  const out = { url: args.url, observation: obs }

  if (args.stateFile) {
    const states = existsSync(args.stateFile) ? JSON.parse(readFileSync(args.stateFile, 'utf8')) : {}
    const { state, alerts } = step(states[args.url], obs)
    if (!args.dryRun) writeFileSync(args.stateFile, JSON.stringify({ ...states, [args.url]: state }, null, 2))
    Object.assign(out, { alerts, labels: labelsFor(alerts), comment: alerts.length ? formatComment(alerts, args.url) : null, state })
    console.log(JSON.stringify(out))
    return
  }

  const repo = process.env.GITHUB_REPOSITORY
  if (!repo || !process.env.GITHUB_TOKEN) throw new Error('issue mode needs GITHUB_REPOSITORY and GITHUB_TOKEN (or pass --state-file)')
  const issue = await monitorIssue(repo, args.url, args.dryRun)
  const states = readStates(issue.body)
  const { state, alerts } = step(states[args.url], obs)
  const labels = labelsFor(alerts)
  const comment = alerts.length ? formatComment(alerts, args.url) : null
  Object.assign(out, { issue: issue.html_url, alerts, labels, comment, state, dryRun: args.dryRun })
  if (!args.dryRun) {
    // Alert first, state second: if the comment fails the state is not
    // saved and the next run alerts again, instead of never.
    if (comment) await api(`/repos/${repo}/issues/${issue.number}/comments`, { method: 'POST', body: { body: comment } })
    if (labels.length) await api(`/repos/${repo}/issues/${issue.number}/labels`, { method: 'POST', body: { labels } })
    if (JSON.stringify(states[args.url] ?? null) !== JSON.stringify(state)) {
      await api(`/repos/${repo}/issues/${issue.number}`, {
        method: 'PATCH',
        body: { body: writeStates(issue.body, { ...states, [args.url]: state }) },
      })
    }
  }
  console.log(JSON.stringify(out))
  summary(
    [
      `## Uptime: ${args.url}`,
      '',
      obs.ok
        ? `Up. bootId ${code(obs.health.bootId)}, startedAt ${code(obs.health.startedAt)}, version ${code(obs.health.version)}, lastShutdown ${code(obs.health.lastShutdown)}.`
        : `Check failed: ${code(obs.error)} (${state.failures} in a row${state.down ? ', down' : ''}).`,
      '',
      comment ? `${args.dryRun ? 'Would post' : 'Posted'} on ${issue.html_url}:\n\n${comment}` : `No alert. Issue: ${issue.html_url}`,
    ].join('\n'),
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    summary(`## Uptime monitor could not run\n\n\`\`\`\n${err?.stack ?? err}\n\`\`\``)
    console.error(err)
    process.exit(1)
  })
}
