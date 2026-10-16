// Uptime monitor (#583). Reads an Elara instance's public `/health` (one
// read-only GET; monitoring, not testing) and compares the process identity
// it reports with the last one seen:
//   - `bootId` changed            -> restart alert (old/new startedAt,
//     version, lastShutdown); `lastShutdown: unclean` also labels the issue.
//     When `previousBootId` is not the bootId last seen, `lastShutdown`
//     describes a process the monitor never saw: the alert says so.
//   - 2 failed checks in a row    -> one down alert
//   - answers again after a down  -> one recovered alert
//   - 7 days without a comment    -> one heartbeat, so a monitor that stopped
//     running shows as a missing weekly comment
// A payload without `bootId` (an image older than #583) is unknown: it is
// recorded, never compared, so it cannot alert in a loop. Every value that
// ends up in a comment is format-checked first: from `/health` (a
// misdirected URL must not be able to write Markdown, links or mentions into
// it) and from the saved state (the issue body can be edited by hand).
//
// Two stores for the last-seen state:
//   - issue mode (the workflow, .github/workflows/uptime.yml): a hidden JSON
//     block in the body of the open issue titled ISSUE_TITLE with the label
//     ISSUE_LABEL; alerts are comments on it, which notify its subscribers.
//     The body is re-read and rewritten only when the state changes.
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
/** A heartbeat comment after this long without one. */
export const HEARTBEAT_MS = 7 * 24 * 60 * 60 * 1000
const SHUTDOWN_KINDS = new Set(['graceful', 'unclean', 'unknown'])
const STATE_BLOCK = /<!-- uptime-state ([\s\S]*?) -->/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/
const SHA = /^[0-9a-f]{7,40}$/

export function emptyState() {
  return {
    bootId: null,
    startedAt: null,
    version: null,
    lastShutdown: null,
    failures: 0,
    firstFailureAt: null,
    down: false,
    heartbeatAt: null,
  }
}

/** The value when it is a string matching `re`, else null. */
const valid = (v, re) => (typeof v === 'string' && re.test(v) ? v : null)
/** An ISO 8601 UTC timestamp that parses, else null. */
const isoTime = (v) => {
  const s = valid(v, ISO)
  return s && Number.isFinite(Date.parse(s)) ? s : null
}
/** Error text for a comment: plain characters only, bounded. */
const plain = (v) => String(v).replace(/[^\w .:/()-]/g, '?').slice(0, 160)

/**
 * A saved state (`readStates`, the state file) with the same format checks as
 * `/health` values: the issue body can be edited by hand, and these values go
 * into comments. Anything else is reset to its empty value. The monitor's own
 * timestamps (`firstFailureAt`, `heartbeatAt`) were written by an earlier run,
 * so one later than `now` is reset too: a future `heartbeatAt` would otherwise
 * stop the weekly check-in for good.
 */
function checkedState(saved, now) {
  const s = saved && typeof saved === 'object' ? saved : {}
  const past = (v) => {
    const t = isoTime(v)
    return t && Date.parse(t) <= Date.parse(now) ? t : null
  }
  return {
    bootId: valid(s.bootId, UUID),
    startedAt: isoTime(s.startedAt),
    version: valid(s.version, SHA),
    lastShutdown: SHUTDOWN_KINDS.has(s.lastShutdown) ? s.lastShutdown : null,
    failures: Number.isInteger(s.failures) && s.failures >= 0 ? Math.min(s.failures, DOWN_AFTER) : 0,
    firstFailureAt: past(s.firstFailureAt),
    down: s.down === true,
    heartbeatAt: past(s.heartbeatAt),
  }
}

/**
 * One `/health` response -> observation. `status` and `body` are what came
 * back; `error` is set when nothing usable did (network error, timeout).
 * Up means HTTP 2xx and `status: 'ok'`; a 503 (database unreachable) is down.
 * Fields with an unexpected format are dropped (null).
 */
export function observe({ at, status = null, body = null, error = null }) {
  if (error) return { at, ok: false, error: plain(error) }
  if (status === null || status < 200 || status >= 300) return { at, ok: false, error: `HTTP ${plain(status)}` }
  if (body?.status !== 'ok') return { at, ok: false, error: `status ${plain(JSON.stringify(body?.status ?? null))}` }
  return {
    at,
    ok: true,
    health: {
      bootId: valid(body.bootId, UUID),
      startedAt: isoTime(body.startedAt),
      version: valid(body.version, SHA),
      lastShutdown: SHUTDOWN_KINDS.has(body.lastShutdown) ? body.lastShutdown : null,
      previousBootId: valid(body.previousBootId, UUID),
    },
  }
}

/**
 * The decision: previous state + observation -> next state + alerts.
 * Every alert fires once per event: a restart once per new bootId, down once
 * per outage (failures stop counting at DOWN_AFTER, so the state does not
 * change while it stays down), recovered once, a heartbeat once per
 * HEARTBEAT_MS.
 */
export function step(prev, obs) {
  const p = checkedState(prev, obs.at)
  const alerts = []
  let state
  if (!obs.ok) {
    const failures = Math.min(p.failures + 1, DOWN_AFTER)
    const firstFailureAt = p.firstFailureAt ?? obs.at
    const down = p.down || failures >= DOWN_AFTER
    if (down && !p.down) alerts.push({ kind: 'down', since: firstFailureAt, at: obs.at, error: obs.error })
    state = { ...p, failures, firstFailureAt, down }
  } else {
    if (p.down) alerts.push({ kind: 'recovered', since: p.firstFailureAt, at: obs.at })
    const h = obs.health
    if (h.bootId && p.bootId && h.bootId !== p.bootId) {
      alerts.push({
        kind: 'restart',
        at: obs.at,
        previous: { bootId: p.bootId, startedAt: p.startedAt, version: p.version },
        current: { bootId: h.bootId, startedAt: h.startedAt, version: h.version },
        lastShutdown: h.lastShutdown ?? 'unknown',
        previousBootId: h.previousBootId,
        // lastShutdown is about h.previousBootId; if that is not the process
        // last seen, at least one more restart happened between checks.
        unseen: h.previousBootId !== null && h.previousBootId !== p.bootId,
      })
    }
    state = {
      ...emptyState(),
      bootId: h.bootId,
      startedAt: h.startedAt,
      version: h.version,
      lastShutdown: h.lastShutdown,
      heartbeatAt: p.heartbeatAt,
    }
  }
  if (!state.heartbeatAt) {
    state.heartbeatAt = obs.at
  } else if (Date.parse(obs.at) - Date.parse(state.heartbeatAt) >= HEARTBEAT_MS) {
    alerts.push({
      kind: 'heartbeat',
      at: obs.at,
      since: state.heartbeatAt,
      ok: obs.ok,
      health: obs.ok ? obs.health : null,
      error: obs.ok ? null : obs.error,
    })
    state.heartbeatAt = obs.at
  }
  return { state, alerts }
}

/**
 * Labels the alerts add to the issue. An `unclean` restart is labelled also
 * when it is `unseen` (about a process between two checks): that is what a
 * crash loop looks like, and an `unclean` left by a data volume that went
 * read-only under the app is an incident worth a look too.
 */
export function labelsFor(alerts) {
  return alerts.some((a) => a.kind === 'restart' && a.lastShutdown === 'unclean') ? [UNCLEAN_LABEL] : []
}

// Each one completes "the previous process ...".
const SHUTDOWN_MEANING = {
  graceful: 'finished a clean SIGTERM/SIGINT shutdown (redeploy, `docker compose restart`, host reboot that stopped the container first)',
  unclean:
    'left no record of a clean shutdown: crash, OOM kill, SIGKILL, uncaught exception, a SIGTERM during boot, a shutdown Docker cut short, or a data directory that went read-only under it. Note edits inside the collab debounce may be lost; queued embedding and extraction work is re-queued by the boot catch-up',
  unknown:
    'left no trustworthy lifecycle marker (first boot on this data directory, a data directory the app could not write, or the previous image predates #583)',
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
      parts.push(
        `### Recovered: ${url}`,
        '',
        `\`/health\` answers again at ${a.at}; down since ${a.since ? `${a.since} (about ${minutes(a.since, a.at)})` : 'an unknown time'}.`,
      )
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
        a.unseen
          ? `**More than one restart since the last check.** The current process follows ${code(a.previousBootId)}, which this monitor never saw, so the process it last saw (${code(a.previous.bootId)}) also restarted, and how that one ended is not known (it may have crashed). lastShutdown **${a.lastShutdown}** is about ${code(a.previousBootId)}, which ${SHUTDOWN_MEANING[a.lastShutdown] ?? SHUTDOWN_MEANING.unknown}.`
          : `lastShutdown: **${a.lastShutdown}**: the previous process ${SHUTDOWN_MEANING[a.lastShutdown] ?? SHUTDOWN_MEANING.unknown}.`,
        ...(a.lastShutdown === 'unclean' ? ['', `Label \`${UNCLEAN_LABEL}\` added; remove it once this restart is explained.`] : []),
      )
    } else if (a.kind === 'heartbeat') {
      parts.push(
        `### Weekly check-in: ${url}`,
        '',
        a.ok
          ? `The monitor is running and \`/health\` is up: bootId ${code(a.health.bootId)}, startedAt ${code(a.health.startedAt)}, version ${code(a.health.version)}.`
          : `The monitor is running and \`/health\` is failing (${code(a.error)}).`,
        `No comment between ${a.since} and this one means no restart and no outage was seen. **If this weekly comment stops coming, the monitor itself is broken**: check the \`uptime.yml\` runs in the Actions tab (a failed scheduled run only emails whoever last edited its cron line).`,
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
    `- \`/health\` failed ${DOWN_AFTER} checks in a row (once per outage), and again when it answers;`,
    '- a week passed without any of these (a heartbeat: if it stops, the monitor is broken).',
    '',
    'Subscribe to this issue to be notified. How it works and how to change it: `docs/agents/github-workflow.md` (Production uptime monitor).',
    '',
    'The block below is the monitor\'s memory (last seen state per URL); do not edit it.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Runner

/** `--url` -> `http(s)://host[:port][/path]`, no credentials, query or fragment; the URL is printed in comments. */
export function normalizeUrl(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`--url must be an http(s) URL, got ${JSON.stringify(raw)}`)
  }
  const out = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || !/^https?:\/\/[A-Za-z0-9.:[\]-]+(\/[\w.~/-]*)?$/.test(out)) {
    throw new Error(`--url must be a plain http(s) URL (host, optional port and path), got ${JSON.stringify(raw)}`)
  }
  return out
}

export function parseArgs(argv) {
  const args = { url: process.env.UPTIME_URL || DEFAULT_URL, stateFile: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') args.url = argv[++i]
    else if (a === '--state-file') args.stateFile = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else throw new Error(`unknown argument ${a}`)
  }
  args.url = normalizeUrl(args.url)
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

/** One GitHub API call -> `{ data, next }` (`next`: the Link header's next page URL). */
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
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return { data: await res.json(), next: /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] }
}

/**
 * The open monitor issue (every page of open ISSUE_LABEL issues is searched),
 * created when there is none. A dry run creates nothing and starts from an
 * empty state.
 */
async function monitorIssue(repo, url, dryRun) {
  for (let next = `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(ISSUE_LABEL)}&per_page=100`; next; ) {
    const page = await api(next)
    const found = page.data.find((i) => !i.pull_request && i.title === ISSUE_TITLE)
    if (found) return found
    next = page.next
  }
  if (dryRun) return { number: null, body: '', html_url: `(no open "${ISSUE_TITLE}" issue labelled ${ISSUE_LABEL}; a real run creates it)` }
  const { data } = await api(`/repos/${repo}/issues`, {
    method: 'POST',
    body: { title: ISSUE_TITLE, labels: [ISSUE_LABEL], body: writeStates(issueBody(url), {}) },
  })
  return data
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
    const r = `/repos/${repo}/issues/${issue.number}`
    // Alert first, state second: if the comment fails the state is not
    // saved and the next run alerts again, instead of never.
    if (comment) await api(`${r}/comments`, { method: 'POST', body: { body: comment } })
    if (labels.length) await api(`${r}/labels`, { method: 'POST', body: { labels } })
    if (JSON.stringify(states[args.url] ?? null) !== JSON.stringify(state)) {
      // Re-read right before writing, so an edit made to the body during
      // this run (a few seconds) is kept; only our URL's state is replaced.
      const { data: fresh } = await api(r)
      await api(r, {
        method: 'PATCH',
        body: { body: writeStates(fresh.body, { ...readStates(fresh.body), [args.url]: state }) },
      })
    }
  }
  console.log(JSON.stringify(out))
  summary(
    [
      `## Uptime: ${args.url}`,
      '',
      obs.ok
        ? `Up. bootId ${code(obs.health.bootId)}, startedAt ${code(obs.health.startedAt)}, version ${code(obs.health.version)}, lastShutdown ${code(obs.health.lastShutdown)}, previousBootId ${code(obs.health.previousBootId)}.`
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
