// #705: server errors, slow requests and failed background jobs were
// invisible; only `/health` was watched. The server now counts requests and
// job outcomes and keeps error reports (route template, status, request id,
// actor, job kind; never note text or the error message) on the
// authenticated GET /api/admin/monitoring, and the uptime monitor
// (.github/scripts/uptime-monitor.mjs) turns new ones into alerts.
//
// Method: run that script against this instance with a state file and
// ALERT_WEBHOOK_URL pointed at a stub sink on the runner (file mode: nothing
// reaches GitHub, so never the real alert issue). Baseline; then inject a
// server error (a note directory made read-only under the app, then a PUT to
// that note: EACCES -> 500, with a marker in the path, the body and the query
// and a token-shaped secret in the query) and a failing job (a git
// repository on an unresolvable `.invalid` host with the secret as its URL
// credential: the first sync fails). The next run must post `errors` and
// `jobs` alerts to the stub; neither the marker nor the secret may appear in
// the payload, the endpoint or the report log lines.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import { poll } from '../lib/portability.ts'

const MONITOR = fileURLToPath(new URL('../../.github/scripts/uptime-monitor.mjs', import.meta.url))
const ENDPOINT = '/api/admin/monitoring'

interface Alert {
  kind: string
  count?: number
  recent?: Array<{ type: string; route?: string | null; status?: number | null; job?: string; reqId?: string | null }>
}
interface MonitorRun {
  code: number
  metrics: { skipped?: string; ok?: boolean; serverErrors?: number; jobFailures?: number; error?: string }
  alerts: Alert[]
  comment: string | null
  webhook: boolean
  stdout: string
}

function monitoringToken(): string {
  if (process.env.ELARA_MONITORING_TOKEN) return process.env.ELARA_MONITORING_TOKEN
  const line = readFileSync('.env', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('ELARA_MONITORING_TOKEN='))
  const token = line?.slice(line.indexOf('=') + 1).trim()
  if (!token) throw new Error('ELARA_MONITORING_TOKEN missing from env and ./.env (lab-instance action)')
  return token
}

/**
 * One monitor run in file mode; `env` is the whole environment (no
 * GITHUB_TOKEN: nothing can reach GitHub). Run from the state file's
 * directory: bun loads `.env` from its working directory, and the repo
 * root's holds this instance's ELARA_MONITORING_TOKEN.
 */
async function monitor(ctx: LabContext, stateFile: string, env: Record<string, string>): Promise<MonitorRun> {
  const proc = Bun.spawn([process.execPath, MONITOR, '--url', ctx.baseUrl, '--state-file', stateFile], {
    cwd: dirname(stateFile),
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`uptime-monitor exited ${code}: ${stderr.slice(0, 1000)}`)
  const out = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Omit<MonitorRun, 'code' | 'stdout'>
  return { ...out, code, stdout }
}

const kinds = (r: MonitorRun) => r.alerts.map((a) => a.kind).join(',') || 'none'

const test: LabTest = {
  name: 'monitoring-alerts',
  tier: 'fast',
  description:
    '#705: an injected server error (read-only note directory -> 500) and a failing git sync each produce an alert from the uptime monitor via ALERT_WEBHOOK_URL (stub sink), with no note text or secret in the payload, the endpoint or the report log lines.',
  async run(ctx) {
    const checks: Check[] = []
    const token = monitoringToken()
    const marker = ctx.uniq('zqmarker')
    const secret = `ghp_${crypto.randomUUID().replace(/-/g, '')}abcd`
    const received: string[] = []
    const sink = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        received.push(await req.text())
        return new Response('ok')
      },
    })
    const dir = mkdtempSync(join(tmpdir(), 'lab-monitoring-'))
    const state = join(dir, 'state.json')
    // Slow endpoints are covered by the script's unit tests: earlier lab tests
    // (first ONNX model load, big imports) are slow on purpose, so the slow
    // threshold is out of reach here and only errors and jobs are asserted.
    const env = { ELARA_MONITORING_TOKEN: token, ALERT_WEBHOOK_URL: `http://127.0.0.1:${sink.port}/hook`, ALERT_SLOW_MS: '3600000' }
    const admin = ctx.rest('admin')
    let noteDir: string | null = null
    try {
      // The workflow without the secret: metrics are skipped, the run passes.
      const unset = await monitor(ctx, join(dir, 'unset.json'), { ELARA_MONITORING_TOKEN: '' })
      checks.push({
        name: 'without ELARA_MONITORING_TOKEN the monitor skips metrics and passes',
        expected: 'exit 0, metrics skipped, alerts [none]',
        actual: `exit ${unset.code}, metrics ${JSON.stringify(unset.metrics)}, alerts [${kinds(unset)}]`,
        ok: unset.code === 0 && !!unset.metrics.skipped && unset.alerts.length === 0,
        severity: 'high',
      })

      const anonymous = await fetch(`${ctx.baseUrl}${ENDPOINT}`)
      const health = (await (await fetch(`${ctx.baseUrl}/health`)).json()) as Record<string, unknown>
      checks.push({
        name: 'the endpoint refuses anonymous callers; /health shows nothing new',
        expected: `${ENDPOINT} 401; /health keys bootId,lastShutdown,previousBootId,startedAt,status,version`,
        actual: `${ENDPOINT} ${anonymous.status}; /health keys ${Object.keys(health).sort().join(',')}`,
        ok: anonymous.status === 401 && Object.keys(health).sort().join(',') === 'bootId,lastShutdown,previousBootId,startedAt,status,version',
        severity: 'high',
      })

      const baseline = await monitor(ctx, state, env)
      checks.push({
        name: 'first run with the token records a baseline without alerting',
        expected: 'metrics ok, alerts [none], nothing posted',
        actual: `metrics ${JSON.stringify(baseline.metrics)}, alerts [${kinds(baseline)}], ${received.length} POST(s)`,
        ok: baseline.metrics.ok === true && baseline.alerts.length === 0 && received.length === 0,
        severity: 'high',
      })

      // Injected server error: the note's directory read-only under the app.
      const vault = await ctx.createVault('admin', ctx.uniq('lab-monitoring'))
      await admin.must('POST', `/api/vaults/${vault.id}/notes`, {
        type: 'docs',
        name: marker,
        body: `note text ${marker} with ${secret}`,
      })
      noteDir = `/data/elara/vaults/${vault.id}/docs`
      const chmod = await ctx.docker.appExec(['chmod', '0555', noteDir])
      if (chmod.code !== 0) throw new Error(`chmod failed: ${chmod.stderr}`)
      const put = await admin.request('PUT', `/api/vaults/${vault.id}/notes/docs/${marker}?q=${marker}&access_token=${secret}`, {
        body: `edited note text ${marker} ${secret}`,
      })
      await ctx.docker.appExec(['chmod', '0755', noteDir])
      noteDir = null
      const repaired = await admin.request('PUT', `/api/vaults/${vault.id}/notes/docs/${marker}`, { body: `repaired ${marker}` })
      checks.push({
        name: 'injected error: a PUT to a note whose directory is read-only answers 500',
        expected: '500, then 200 once writable again',
        actual: `${put.status}, then ${repaired.status}`,
        ok: put.status === 500 && repaired.status === 200,
        severity: 'high',
      })

      // Failing job: the first sync of an unresolvable remote.
      const repo = await admin.must<{ id: string }>('POST', '/api/repositories', {
        name: ctx.uniq('lab-monitoring-repo'),
        ingestionMethod: 'git',
        gitUrl: `https://x-access-token:${secret}@elara-lab.invalid/${marker}/repo.git`,
      })
      const syncStatus = await poll(async () => {
        const list = await admin.must<Array<{ id: string; syncStatus: string }>>('GET', '/api/repositories')
        const s = list.find((r) => r.id === repo.id)?.syncStatus
        return s === 'error' || s === 'idle' ? s : undefined
      }, 90_000, 1_000)
      checks.push({
        name: 'failing job: the first sync of an unresolvable remote fails',
        expected: 'syncStatus error',
        actual: `syncStatus ${syncStatus ?? 'still syncing after 90 s'}`,
        ok: syncStatus === 'error',
        severity: 'high',
      })

      const alerted = await monitor(ctx, state, env)
      const errors = alerted.alerts.find((a) => a.kind === 'errors')
      const jobs = alerted.alerts.find((a) => a.kind === 'jobs')
      const posted = received.map((r) => JSON.parse(r) as { text: string; alerts: Alert[] })
      const postedKinds = posted.flatMap((p) => p.alerts.map((a) => a.kind))
      checks.push({
        name: 'the injected server error produces an errors alert with the route template, through the webhook',
        expected: "alerts include errors with a 500 on 'PUT /api/vaults/:id/notes/*'; one POST to the stub carrying it",
        actual: `alerts [${kinds(alerted)}]; errors ${JSON.stringify(errors?.recent ?? null)}; ${received.length} POST(s) with [${postedKinds.join(',')}]`,
        ok:
          !!errors?.recent?.some((e) => e.route === 'PUT /api/vaults/:id/notes/*' && e.status === 500) &&
          received.length === 1 &&
          postedKinds.includes('errors'),
        severity: 'critical',
      })
      checks.push({
        name: 'the failing sync produces a jobs alert, through the webhook',
        expected: 'alerts include jobs with a sync failure; the POST carries it',
        actual: `jobs ${JSON.stringify(jobs ?? null)}`,
        ok: !!jobs?.recent?.some((e) => e.job === 'sync') && postedKinds.includes('jobs'),
        severity: 'critical',
      })

      const snapshot = await (await fetch(`${ctx.baseUrl}${ENDPOINT}`, { headers: { authorization: `Bearer ${token}` } })).text()
      const reportLines = (await ctx.docker.app.logs('app', 5000))
        .split('\n')
        .map((l) => l.slice(l.indexOf('{')))
        .filter((l) => l.startsWith('{"event":"server_error"') || l.startsWith('{"event":"job_failure"'))
      const leaks = (label: string, text: string) =>
        [text.includes(marker) ? `${label}: marker` : '', text.includes(secret) ? `${label}: secret` : ''].filter(Boolean)
      const found = [
        ...leaks('webhook payload', received.join('\n')),
        ...leaks('monitor output', alerted.stdout),
        ...leaks('endpoint', snapshot),
        ...leaks('report log lines', reportLines.join('\n')),
      ]
      checks.push({
        name: 'no note text, path, query or secret in the alert, the endpoint or the report log lines',
        expected: `marker and secret absent; at least one server_error and one job_failure log line`,
        actual: `${found.length ? found.join('; ') : 'absent'}; ${reportLines.filter((l) => l.includes('server_error')).length} server_error, ${reportLines.filter((l) => l.includes('job_failure')).length} job_failure line(s)`,
        ok:
          found.length === 0 &&
          reportLines.some((l) => l.includes('"server_error"')) &&
          reportLines.some((l) => l.includes('"job_failure"')),
        severity: 'critical',
      })

      const postsBefore = received.length
      const again = await monitor(ctx, state, env)
      checks.push({
        name: 'each failure is alerted once',
        expected: 'next run: no errors or jobs alert, no new POST',
        actual: `alerts [${kinds(again)}], ${received.length - postsBefore} new POST(s)`,
        ok: !again.alerts.some((a) => a.kind === 'errors' || a.kind === 'jobs') && received.length === postsBefore,
        severity: 'high',
      })

      return {
        summary: `Monitor runs (file mode, webhook to a stub sink): no token [${kinds(unset)}], baseline [${kinds(baseline)}], after a 500 and a failed sync [${kinds(alerted)}], again [${kinds(again)}]; ${received.length} webhook POST(s); leaks: ${found.length ? found.join('; ') : 'none'}.`,
        checks,
        data: { runs: { unset, baseline, alerted, again }, webhook: posted, reportLines },
      }
    } finally {
      if (noteDir) await ctx.docker.appExec(['chmod', '0755', noteDir])
      void sink.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  },
}
export default test
