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
// With ELARA_MONITORING_TOKEN set (#705) it also reads the authenticated
// METRICS_PATH while `/health` is up, and alerts on:
//   - errors: at least ALERT_ERROR_THRESHOLD (default 1) new 5xx responses
//     since the last check (the server's counters are cumulative since boot,
//     so a late check loses nothing; a new bootId counts from zero)
//   - jobs: any new failed background job (embedding, extraction, sync,
//     collab-store, backup; a repository that keeps failing counts once, on
//     its way into `error`, a scheduled backup once per run of failures; the
//     server's `repeated` count of the rest is listed in the comment)
//   - slow: a route that newly has p95 >= ALERT_SLOW_MS (default 2000) over
//     at least ALERT_SLOW_MIN_COUNT (default 5) requests in the server's
//     15-minute window (once until it is fast again)
//   - metrics-unavailable: the endpoint fails DOWN_AFTER reads in a row while
//     `/health` is up (once per streak: a wrong or rotated token)
// `errors` and `jobs` alert once per streak, not on every run: while new ones
// keep coming, the next comment is for a route or job kind the streak has not
// had yet, or after REALERT_MS (24 h) with the count held back meanwhile; a
// streak ends after QUIET_MS (1 h) without a new one, with a closing note when
// something was held back.
// The server's reports carry no note text and no error message (route
// template, status, error class and code, request id, actor kind, job kind);
// subject ids are left out here too, because comments and the Actions log
// are public. Unset token = none of this, and nothing fails.
// ALERT_WEBHOOK_URL (optional, for self-hosters running this from cron):
// every comment is also POSTed there as JSON `{text, content, url, alerts}`.
// In issue mode a malformed value is reported and ignored (the comment is the
// alert of record); in file mode, where it is the only sink, it stops the run.
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
//     is posted to GitHub (only to ALERT_WEBHOOK_URL when set).
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

/** The server's monitoring endpoint (server/src/monitoring/routes.ts). */
export const METRICS_PATH = '/api/admin/monitoring'
export const JOB_KINDS = ['embedding', 'extraction', 'sync', 'collab-store', 'backup']
export const METRICS_DEFAULTS = { errorThreshold: 1, slowMs: 2000, slowMinCount: 5 }
/** Error records listed per alert (the newest). */
export const RECENT_ERRORS = 10
/** While `errors` or `jobs` keep coming, the same alert again after this long (with the count held back). */
export const REALERT_MS = 24 * 60 * 60 * 1000
/** A streak of `errors` or `jobs` ends after this long without a new one. */
export const QUIET_MS = 60 * 60 * 1000
/**
 * Routes or job kinds a streak remembers (a new one alerts at once). Covers
 * the server's route keys (MAX_ROUTES 300 in server/src/monitoring/metrics.ts,
 * plus one `METHOD (other)` per method); once a streak is full, an unknown
 * key is held like a known one, so it cannot alert on every run.
 */
export const STREAK_KEYS = 320
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|OTHER) (\/[\w/:*.-]{0,200}|\(other\))$/
const IDENT = /^[A-Za-z][\w.-]{0,63}$/
const ERROR_CODE = /^[\w.-]{1,64}$/
const REQ_ID = /^[\w.-]{1,64}$/
const ACTORS = new Set(['user', 'token', 'anonymous'])

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
    metrics: null,
  }
}

/** The value when it is a string matching `re`, else null. */
const valid = (v, re) => (typeof v === 'string' && re.test(v) ? v : null)
/** An ISO 8601 UTC timestamp that parses, else null. */
const isoTime = (v) => {
  const s = valid(v, ISO)
  return s && Number.isFinite(Date.parse(s)) ? s : null
}
/** A timestamp the monitor wrote in an earlier run: valid and not later than `now`, else null. */
const pastTime = (v, now) => {
  const t = isoTime(v)
  return t && Date.parse(t) <= Date.parse(now) ? t : null
}
/** Error text for a comment: plain characters only, bounded. */
const plain = (v) => String(v).replace(/[^\w .:/()-]/g, '?').slice(0, 160)

/**
 * A saved state (`readStates`, the state file) with the same format checks as
 * `/health` values: the issue body can be edited by hand, and these values go
 * into comments. Anything else is reset to its empty value. The monitor's own
 * timestamps (`firstFailureAt`, `heartbeatAt`, the metrics streaks) were
 * written by an earlier run, so one later than `now` is reset too: a future
 * `heartbeatAt` would otherwise stop the weekly check-in for good.
 */
function checkedState(saved, now) {
  const s = saved && typeof saved === 'object' ? saved : {}
  return {
    bootId: valid(s.bootId, UUID),
    startedAt: isoTime(s.startedAt),
    version: valid(s.version, SHA),
    lastShutdown: SHUTDOWN_KINDS.has(s.lastShutdown) ? s.lastShutdown : null,
    failures: Number.isInteger(s.failures) && s.failures >= 0 ? Math.min(s.failures, DOWN_AFTER) : 0,
    firstFailureAt: pastTime(s.firstFailureAt, now),
    down: s.down === true,
    heartbeatAt: pastTime(s.heartbeatAt, now),
    metrics: checkedMetricsState(s.metrics, now),
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
      metrics: p.metrics,
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

// ---------------------------------------------------------------------------
// Error, job and latency alerts (#705)

/** A count: a non-negative integer, else 0. */
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0)

/** A saved `errors`/`jobs` streak (see streakStep), or null when any field is off. */
function checkedStreak(s, keyOk, now) {
  if (!s || typeof s !== 'object') return null
  const since = pastTime(s.since, now)
  const lastAt = pastTime(s.lastAt, now)
  const alertedAt = pastTime(s.alertedAt, now)
  if (!since || !lastAt || !alertedAt) return null
  const keys = Array.isArray(s.keys) ? [...new Set(s.keys.filter(keyOk))].slice(0, STREAK_KEYS) : []
  return { since, lastAt, alertedAt, held: count(s.held), keys }
}

/** The saved metrics state, format-checked like the rest (null = never read). */
function checkedMetricsState(s, now) {
  if (!s || typeof s !== 'object') return null
  const streaks = s.streaks && typeof s.streaks === 'object' ? s.streaks : {}
  return {
    bootId: valid(s.bootId, UUID),
    serverErrors: count(s.serverErrors),
    jobFailures: count(s.jobFailures),
    lastSeq: count(s.lastSeq),
    slow: Array.isArray(s.slow) ? s.slow.filter((r) => valid(r, ROUTE)).slice(0, 50) : [],
    failedReads: Math.min(count(s.failedReads), DOWN_AFTER),
    streaks: {
      errors: checkedStreak(streaks.errors, (k) => valid(k, ROUTE) !== null, now),
      jobs: checkedStreak(streaks.jobs, (k) => JOB_KINDS.includes(k), now),
    },
    // A streak dropped for a time later than now (a hand edit, a clock
    // change) still owes its held count: kept here until a read reports it.
    resetHeld: Object.fromEntries(
      ['errors', 'jobs'].map((kind) => {
        const raw = streaks[kind]
        const future = raw && typeof raw === 'object' && [raw.since, raw.lastAt, raw.alertedAt].some((v) => isoTime(v) && !pastTime(v, now))
        return [kind, count(s.resetHeld?.[kind]) + (future ? count(raw.held) : 0)]
      }),
    ),
  }
}

/** One record of the endpoint's `errors`, format-checked; the subject id is dropped (comments are public). */
function checkedRecord(e) {
  if (!e || typeof e !== 'object') return null
  const error = e.error && typeof e.error === 'object' ? { name: valid(e.error.name, IDENT), code: valid(e.error.code, ERROR_CODE) } : null
  const base = { seq: count(e.seq), at: isoTime(e.at), error }
  if (e.type === 'request') {
    return {
      ...base,
      type: 'request',
      reqId: valid(e.reqId, REQ_ID),
      route: valid(e.route, ROUTE),
      status: Number.isInteger(e.status) && e.status >= 500 && e.status <= 599 ? e.status : null,
      durationMs: count(e.durationMs),
      actor: ACTORS.has(e.actor) ? e.actor : null,
    }
  }
  if (e.type === 'job' && JOB_KINDS.includes(e.job)) return { ...base, type: 'job', job: e.job }
  return null
}

/**
 * One METRICS_PATH response -> observation, every value format-checked
 * (a misdirected URL must not write Markdown into a comment either).
 */
export function observeMetrics({ status = null, body = null, error = null }) {
  if (error) return { ok: false, error: plain(error) }
  if (status === null || status < 200 || status >= 300) return { ok: false, error: `HTTP ${plain(status)}` }
  const bootId = valid(body?.bootId, UUID)
  if (!bootId || !body.totals || typeof body.totals !== 'object') return { ok: false, error: 'unexpected response' }
  return {
    ok: true,
    bootId,
    serverErrors: count(body.totals.serverErrors),
    jobFailures: count(body.totals.jobFailures),
    jobs: Object.fromEntries(JOB_KINDS.map((k) => [k, count(body.jobs?.[k]?.failed)])),
    repeated: Object.fromEntries(JOB_KINDS.map((k) => [k, count(body.jobs?.[k]?.repeated)])),
    routes: (Array.isArray(body.routes) ? body.routes : [])
      .filter((r) => valid(r?.route, ROUTE))
      .slice(0, 1000)
      .map((r) => ({ route: r.route, count: count(r.count), p95Ms: count(r.p95Ms), maxMs: count(r.maxMs) })),
    errors: (Array.isArray(body.errors) ? body.errors : []).slice(-200).map(checkedRecord).filter(Boolean),
    lastSeq: count(body.lastSeq),
  }
}

/** ALERT_* variables -> thresholds; anything but a positive integer keeps the default. */
export function metricsOptions(env = process.env) {
  const positive = (v, fallback) => (/^\d+$/.test(v ?? '') && Number(v) > 0 ? Number(v) : fallback)
  return {
    errorThreshold: positive(env.ALERT_ERROR_THRESHOLD, METRICS_DEFAULTS.errorThreshold),
    slowMs: positive(env.ALERT_SLOW_MS, METRICS_DEFAULTS.slowMs),
    slowMinCount: positive(env.ALERT_SLOW_MIN_COUNT, METRICS_DEFAULTS.slowMinCount),
  }
}

/**
 * One `errors` or `jobs` streak -> next streak + whether this run alerts.
 * `n` is this run's new count (0 when below the threshold), `keys` the routes
 * or job kinds of this run's new records. No streak (or QUIET_MS since the
 * last new one): a new streak, alert. In a streak: alert for a key the streak
 * has not had (a new failure condition; only while it has room for
 * STREAK_KEYS) or REALERT_MS after the last alert, with the count held back
 * since; otherwise hold the count back. A quiet QUIET_MS ends the streak,
 * with a closing note when something was held back (so no count goes
 * unreported).
 */
function streakStep(s, n, keys, at) {
  const t = Date.parse(at)
  const quiet = s !== null && t - Date.parse(s.lastAt) >= QUIET_MS
  if (n === 0) {
    if (!quiet) return { streak: s, alert: null, ended: null }
    return { streak: null, alert: null, ended: s.held > 0 ? s : null }
  }
  const ended = quiet && s.held > 0 ? s : null
  if (s === null || quiet) {
    return { streak: { since: at, lastAt: at, alertedAt: at, held: 0, keys: keys.slice(0, STREAK_KEYS) }, alert: { since: at, held: 0, lastAlertAt: null }, ended }
  }
  const merged = [...new Set([...s.keys, ...keys])].slice(0, STREAK_KEYS)
  const newKey = s.keys.length < STREAK_KEYS && keys.some((k) => !s.keys.includes(k))
  if (!newKey && t - Date.parse(s.alertedAt) < REALERT_MS) {
    return { streak: { ...s, lastAt: at, held: s.held + n, keys: merged }, alert: null, ended: null }
  }
  return {
    streak: { ...s, lastAt: at, alertedAt: at, held: 0, keys: merged },
    alert: { since: s.since, held: s.held, lastAlertAt: s.alertedAt },
    ended: null,
  }
}

/**
 * Saved metrics state + observation -> next state + alerts. The first read
 * (no saved bootId) is a baseline. Counters are cumulative since boot: the
 * same bootId compares with the saved counts, a new one counts from zero
 * (everything since the restart is new). A spike below the threshold is not
 * carried over to the next check. `errors` and `jobs` alert once per streak
 * (streakStep), a slow route once until it drops out of the slow set, an
 * unreadable endpoint once per streak of DOWN_AFTER failed reads.
 */
export function stepMetrics(prev, mobs, opts = METRICS_DEFAULTS, at = new Date().toISOString()) {
  const p = checkedMetricsState(prev, at)
  const streaks = p?.streaks ?? { errors: null, jobs: null }
  const resetHeld = p?.resetHeld ?? { errors: 0, jobs: 0 }
  if (!mobs.ok) {
    const base = p ?? { bootId: null, serverErrors: 0, jobFailures: 0, lastSeq: 0, slow: [], failedReads: 0, streaks, resetHeld }
    const failedReads = Math.min(base.failedReads + 1, DOWN_AFTER)
    return {
      state: { ...base, failedReads },
      alerts: base.failedReads + 1 === DOWN_AFTER ? [{ kind: 'metrics-unavailable', at, reads: DOWN_AFTER, error: mobs.error }] : [],
    }
  }
  const slowNow = mobs.routes.filter((r) => r.count >= opts.slowMinCount && r.p95Ms >= opts.slowMs)
  const state = {
    bootId: mobs.bootId,
    serverErrors: mobs.serverErrors,
    jobFailures: mobs.jobFailures,
    lastSeq: mobs.lastSeq,
    slow: slowNow.map((r) => r.route),
    failedReads: 0,
    streaks,
    resetHeld,
  }
  if (!p?.bootId) return { state, alerts: [] }
  const restarted = p.bootId !== mobs.bootId
  const since = (now, saved) => (restarted || now < saved ? now : now - saved)
  const newErrors = since(mobs.serverErrors, p.serverErrors)
  const newFailures = since(mobs.jobFailures, p.jobFailures)
  const fromSeq = restarted || mobs.lastSeq < p.lastSeq ? 0 : p.lastSeq
  const fresh = mobs.errors.filter((e) => e.seq > fromSeq)
  const requests = fresh.filter((e) => e.type === 'request')
  const failedJobs = fresh.filter((e) => e.type === 'job')
  const alerts = []

  const errs = streakStep(
    streaks.errors,
    newErrors >= opts.errorThreshold ? newErrors : 0,
    [...new Set(requests.map((e) => e.route).filter(Boolean))],
    at,
  )
  const jobs = streakStep(streaks.jobs, newFailures, [...new Set(failedJobs.map((e) => e.job))], at)
  state.streaks = { errors: errs.streak, jobs: jobs.streak }
  state.resetHeld = { errors: 0, jobs: 0 }
  for (const [of, r] of [['errors', errs], ['jobs', jobs]]) {
    if (resetHeld[of] > 0) alerts.push({ kind: 'settled', of, at, reset: true, held: resetHeld[of] })
    if (r.ended) alerts.push({ kind: 'settled', of, at, since: r.ended.since, lastAt: r.ended.lastAt, alertedAt: r.ended.alertedAt, held: r.ended.held })
  }
  if (errs.alert) {
    alerts.push({
      kind: 'errors',
      at,
      count: newErrors,
      threshold: opts.errorThreshold,
      restarted,
      streak: errs.alert,
      recent: requests.slice(-RECENT_ERRORS),
    })
  }
  if (jobs.alert) {
    alerts.push({
      kind: 'jobs',
      at,
      count: newFailures,
      restarted,
      streak: jobs.alert,
      failedSinceBoot: mobs.jobs,
      repeatedSinceBoot: mobs.repeated,
      recent: failedJobs.slice(-RECENT_ERRORS),
    })
  }
  const newlySlow = slowNow.filter((r) => !p.slow.includes(r.route))
  if (newlySlow.length > 0) {
    alerts.push({ kind: 'slow', at, slowMs: opts.slowMs, minCount: opts.slowMinCount, routes: newlySlow })
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
const errorText = (e) => (e?.name || e?.code ? code([e.name, e.code].filter(Boolean).join(' ')) : '_none_')

function minutes(from, to) {
  const ms = Date.parse(to) - Date.parse(from)
  return Number.isFinite(ms) ? `${Math.max(0, Math.round(ms / 60_000))} min` : 'unknown'
}

const STREAK_WORDS = {
  errors: { title: 'Server errors', items: '5xx responses', key: 'route' },
  jobs: { title: 'Failed background jobs', items: 'failed jobs', key: 'job kind' },
}

/** The lines of an `errors`/`jobs` alert about its streak (stepMetrics: once per streak, not every run). */
function streakText(s, w) {
  if (!s) return []
  const next = `Until they stop for ${QUIET_MS / 60_000} min, more ${w.items} get a comment only for a ${w.key} not seen in this streak, or after ${REALERT_MS / 3_600_000} h.`
  if (!s.lastAlertAt) return ['', next]
  return ['', `Still happening since ${s.since}: ${s.held} more ${w.items} since the last comment (${s.lastAlertAt}) were held back. ${next}`]
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
    } else if (a.kind === 'errors') {
      parts.push(
        `### Server errors: ${url}`,
        '',
        `${a.count} new 5xx response${a.count === 1 ? '' : 's'} ${a.restarted ? 'since the restart' : 'since the last check'} (alert threshold ${a.threshold}).${a.recent.length ? ' The newest:' : ''}`,
        ...(a.recent.length
          ? [
              '',
              '| at | route | status | error | request id | actor | ms |',
              '|---|---|---|---|---|---|---|',
              ...a.recent.map(
                (e) => `| ${code(e.at)} | ${code(e.route)} | ${e.status ?? '_none_'} | ${errorText(e.error)} | ${code(e.reqId)} | ${code(e.actor)} | ${e.durationMs} |`,
              ),
            ]
          : []),
        '',
        'Reports carry the error class and code only, never its message or the note it touched: the full error is in the server log under the request id (`docker compose logs app | grep <request id>`).',
        ...streakText(a.streak, STREAK_WORDS.errors),
      )
    } else if (a.kind === 'jobs') {
      const sinceBoot = Object.entries(a.failedSinceBoot).filter(([, n]) => n > 0)
      const repeated = Object.entries(a.repeatedSinceBoot ?? {}).filter(([, n]) => n > 0)
      parts.push(
        `### Failed background jobs: ${url}`,
        '',
        `${a.count} new failed job${a.count === 1 ? '' : 's'} ${a.restarted ? 'since the restart' : 'since the last check'}.${a.recent.length ? ' The newest:' : ''}`,
        ...(a.recent.length
          ? ['', '| at | job | error |', '|---|---|---|', ...a.recent.map((e) => `| ${code(e.at)} | ${code(e.job)} | ${errorText(e.error)} |`)]
          : []),
        '',
        `Failed since the process started: ${sinceBoot.length ? sinceBoot.map(([k, n]) => `${code(k)} ${n}`).join(', ') : '_none_'}.${repeated.length ? ` Failed again while already failing (a repository still in \`error\`, a backup after a failed one; counted, never alerted): ${repeated.map(([k, n]) => `${code(k)} ${n}`).join(', ')}.` : ''} The note, file, repository or vault each one was about is on \`${METRICS_PATH}\` (admin session) and in the server log's \`job_failure\` lines. A failed \`collab-store\` means a live edit was not written to the note file.`,
        ...streakText(a.streak, STREAK_WORDS.jobs),
      )
    } else if (a.kind === 'slow') {
      parts.push(
        `### Slow endpoints: ${url}`,
        '',
        `p95 at or above ${a.slowMs} ms over at least ${a.minCount} requests in the server's last 15 minutes (percentiles are latency-bucket upper bounds):`,
        '',
        '| route | p95 ms | max ms | requests |',
        '|---|---|---|---|',
        ...a.routes.map((r) => `| ${code(r.route)} | ${r.p95Ms} | ${r.maxMs} | ${r.count} |`),
      )
    } else if (a.kind === 'settled') {
      const w = STREAK_WORDS[a.of]
      parts.push(
        ...(a.reset
          ? [
              `### ${w.title} streak reset: ${url}`,
              '',
              `The saved streak had a time later than now (a hand edit or a clock change), so it was reset. ${a.held} ${w.items} held back in it were not commented one by one.`,
            ]
          : [
              `### ${w.title} stopped: ${url}`,
              '',
              `No new ${w.items} since ${a.lastAt}; this streak began at ${a.since}. ${a.held} more after the last comment (${a.alertedAt}) were held back, not commented one by one.`,
            ]),
      )
    } else if (a.kind === 'metrics-unavailable') {
      parts.push(
        `### Metrics unavailable: ${url}`,
        '',
        `\`/health\` is up but \`${METRICS_PATH}\` failed ${a.reads ?? DOWN_AFTER} reads in a row (last: ${code(a.error)}), so error, job and latency alerts are paused. Check \`ELARA_MONITORING_TOKEN\` on the server and the repository secret of the same name (they must match). One comment per streak.`,
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
    '- a week passed without any of these (a heartbeat: if it stops, the monitor is broken);',
    `- with the \`ELARA_MONITORING_TOKEN\` secret set (#705): new server errors (5xx), failed background jobs, newly slow endpoints, and a \`${METRICS_PATH}\` that stopped answering.`,
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

/** Reads METRICS_PATH with the monitoring token -> observeMetrics(). */
async function probeMetrics(url, token) {
  try {
    const res = await fetch(`${url}${METRICS_PATH}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'elara-uptime-monitor (#705)' },
      signal: AbortSignal.timeout(15_000),
    })
    let body = null
    try {
      body = await res.json()
    } catch {
      /* not JSON: observeMetrics() reports the status */
    }
    return observeMetrics({ status: res.status, body })
  } catch (err) {
    return observeMetrics({ error: err?.cause?.code ?? err?.message ?? err })
  }
}

/**
 * The metrics part of a run: skipped (state kept) without a token or while
 * `/health` is down. `summary` is what the run prints (the Actions log is
 * public: counts only, no records).
 */
async function checkMetrics(url, token, opts, obs, state) {
  if (!token) return { state, alerts: [], summary: { skipped: 'ELARA_MONITORING_TOKEN not set' } }
  if (!obs.ok) return { state, alerts: [], summary: { skipped: '/health is down' } }
  const mobs = await probeMetrics(url, token)
  const m = stepMetrics(state.metrics, mobs, opts, obs.at)
  const summary = mobs.ok
    ? { ok: true, bootId: mobs.bootId, serverErrors: mobs.serverErrors, jobFailures: mobs.jobFailures, slow: m.state.slow }
    : { ok: false, error: mobs.error }
  return { state: { ...state, metrics: m.state }, alerts: m.alerts, summary }
}

/** ALERT_WEBHOOK_URL -> URL, or null when unset. Never echoed: a webhook URL is a secret. */
export function webhookTarget(raw) {
  if (!raw) return null
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error('ALERT_WEBHOOK_URL is not a URL')
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('ALERT_WEBHOOK_URL must be an http(s) URL')
  return u.href
}

/**
 * ALERT_WEBHOOK_URL for this run -> `{ target, warning }`. In file mode the
 * webhook is the only sink, so a malformed value stops the run. In issue mode
 * the comment is the alert of record: a malformed optional secret must not
 * stop the restart and down alerts, so it is a warning and no webhook.
 */
export function webhookConfig(raw, fileMode) {
  if (fileMode) return { target: webhookTarget(raw), warning: null }
  try {
    return { target: webhookTarget(raw), warning: null }
  } catch (err) {
    return { target: null, warning: `${err.message}; ignored` }
  }
}

/** The webhook body: `text` (Slack and most chat webhooks), `content` (Discord, 2000 chars), and the alerts as data. */
export function webhookPayload(alerts, url, comment) {
  return { text: comment, content: comment.length > 2000 ? `${comment.slice(0, 1990)}\n…` : comment, url, alerts }
}

async function postWebhook(target, payload) {
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'elara-uptime-monitor (#705)' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`ALERT_WEBHOOK_URL answered HTTP ${res.status}`)
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
  const token = process.env.ELARA_MONITORING_TOKEN || ''
  const { target: hook, warning: hookWarning } = webhookConfig(process.env.ALERT_WEBHOOK_URL, Boolean(args.stateFile))
  if (hookWarning) console.warn(`webhook not used: ${hookWarning}`)
  const opts = metricsOptions()
  const obs = await probe(args.url)
  const out = { url: args.url, observation: obs }

  if (args.stateFile) {
    const states = existsSync(args.stateFile) ? JSON.parse(readFileSync(args.stateFile, 'utf8')) : {}
    const health = step(states[args.url], obs)
    const m = await checkMetrics(args.url, token, opts, obs, health.state)
    const alerts = [...health.alerts, ...m.alerts]
    const comment = alerts.length ? formatComment(alerts, args.url) : null
    // Webhook first, state second (the state file is not a sink): a failed
    // POST exits non-zero and the next run alerts again.
    if (comment && hook && !args.dryRun) await postWebhook(hook, webhookPayload(alerts, args.url, comment))
    if (!args.dryRun) writeFileSync(args.stateFile, JSON.stringify({ ...states, [args.url]: m.state }, null, 2))
    Object.assign(out, { metrics: m.summary, alerts, labels: labelsFor(alerts), comment, webhook: Boolean(comment && hook && !args.dryRun), state: m.state })
    console.log(JSON.stringify(out))
    return
  }

  const repo = process.env.GITHUB_REPOSITORY
  if (!repo || !process.env.GITHUB_TOKEN) throw new Error('issue mode needs GITHUB_REPOSITORY and GITHUB_TOKEN (or pass --state-file)')
  const issue = await monitorIssue(repo, args.url, args.dryRun)
  const states = readStates(issue.body)
  const health = step(states[args.url], obs)
  const m = await checkMetrics(args.url, token, opts, obs, health.state)
  const state = m.state
  const alerts = [...health.alerts, ...m.alerts]
  const labels = labelsFor(alerts)
  const comment = alerts.length ? formatComment(alerts, args.url) : null
  let webhook = hookWarning
  Object.assign(out, { issue: issue.html_url, metrics: m.summary, alerts, labels, comment, state, dryRun: args.dryRun })
  if (!args.dryRun) {
    const r = `/repos/${repo}/issues/${issue.number}`
    // Alert first, state second: if the comment fails the state is not
    // saved and the next run alerts again, instead of never.
    if (comment) await api(`${r}/comments`, { method: 'POST', body: { body: comment } })
    // The comment is the alert of record here: a webhook that fails is
    // reported, not retried (a retry would post the comment twice).
    if (comment && hook) {
      try {
        await postWebhook(hook, webhookPayload(alerts, args.url, comment))
        webhook = 'sent'
      } catch (err) {
        webhook = plain(err?.message ?? err)
        console.warn(`webhook not sent: ${webhook}`)
      }
    }
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
  out.webhook = webhook
  console.log(JSON.stringify(out))
  summary(
    [
      `## Uptime: ${args.url}`,
      '',
      obs.ok
        ? `Up. bootId ${code(obs.health.bootId)}, startedAt ${code(obs.health.startedAt)}, version ${code(obs.health.version)}, lastShutdown ${code(obs.health.lastShutdown)}, previousBootId ${code(obs.health.previousBootId)}.`
        : `Check failed: ${code(obs.error)} (${state.failures} in a row${state.down ? ', down' : ''}).`,
      '',
      m.summary.skipped
        ? `Metrics: skipped (${m.summary.skipped}).`
        : m.summary.ok
          ? `Metrics: ${m.summary.serverErrors} 5xx and ${m.summary.jobFailures} failed jobs since boot; slow routes: ${m.summary.slow.length ? m.summary.slow.map(code).join(', ') : '_none_'}.`
          : `Metrics: ${code(METRICS_PATH)} failed (${code(m.summary.error)}).`,
      ...(webhook ? ['', `Webhook: ${webhook}.`] : []),
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
