// #583: production restarted (likely OOM) during the study and nobody
// noticed. `/health` now reports the process identity (bootId, startedAt,
// version, lastShutdown from the DATA_DIR lifecycle marker), and
// .github/scripts/uptime-monitor.mjs, the script the scheduled
// `uptime.yml` workflow runs against production, turns changes into alerts.
//
// Method: run that same script against this lab instance (`--url`, with a
// state file instead of the production issue) between real restarts:
// baseline, no change, `docker compose restart app` (SIGTERM), SIGKILL,
// `docker compose stop app` for three checks, start. Each run's alerts are
// the comment the workflow would post.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Check, LabContext, LabTest } from '../lib/context.ts'

const MONITOR = fileURLToPath(new URL('../../.github/scripts/uptime-monitor.mjs', import.meta.url))

interface Alert {
  kind: 'restart' | 'down' | 'recovered' | 'heartbeat'
  lastShutdown?: string
  previous?: { bootId: string | null }
  current?: { bootId: string | null }
  previousBootId?: string | null
  unseen?: boolean
}
interface MonitorRun {
  observation: {
    ok: boolean
    error?: string
    health?: { bootId: string | null; startedAt: string | null; version: string | null; lastShutdown: string | null; previousBootId: string | null }
  }
  alerts: Alert[]
  labels: string[]
  comment: string | null
}

async function monitor(ctx: LabContext, stateFile: string): Promise<MonitorRun> {
  const r = await ctx.docker.exec([process.execPath, MONITOR, '--url', ctx.baseUrl, '--state-file', stateFile])
  if (r.code !== 0) throw new Error(`uptime-monitor exited ${r.code}: ${r.stderr.slice(0, 1000)}`)
  const last = r.stdout.trim().split('\n').at(-1) ?? ''
  return JSON.parse(last) as MonitorRun
}

const kinds = (r: MonitorRun) => r.alerts.map((a) => a.kind).join(',') || 'none'
const describeRun = (r: MonitorRun) =>
  `alerts [${kinds(r)}]` +
  r.alerts
    .filter((a) => a.kind === 'restart')
    .map((a) => ` lastShutdown=${a.lastShutdown} ${a.previous?.bootId} -> ${a.current?.bootId}${a.unseen ? ` (unseen: follows ${a.previousBootId})` : ''}`)
    .join('') +
  (r.labels.length ? ` labels [${r.labels.join(',')}]` : '')

const test: LabTest = {
  name: 'uptime-monitor',
  tier: 'fast',
  description: '#583: the uptime monitor against this instance alerts on a graceful restart, an unclean (SIGKILL) restart, a down and a recovery, once each.',
  async run(ctx) {
    const checks: Check[] = []
    const dir = mkdtempSync(join(tmpdir(), 'lab-uptime-'))
    const state = join(dir, 'state.json')
    const runs: Record<string, MonitorRun> = {}
    try {
      runs.baseline = await monitor(ctx, state)
      const h = runs.baseline.observation.health
      const expectedVersion = process.env.GITHUB_SHA ?? null
      checks.push({
        name: '/health reports the process identity',
        expected: `bootId (UUIDv7), startedAt, lastShutdown set; version ${expectedVersion ?? 'any'}`,
        actual: JSON.stringify(h ?? runs.baseline.observation),
        ok:
          !!h &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(h.bootId ?? '') &&
          !Number.isNaN(Date.parse(h.startedAt ?? '')) &&
          h.lastShutdown !== null &&
          (expectedVersion === null || h.version === expectedVersion),
        severity: 'high',
      })
      checks.push({
        name: 'first check records a baseline without alerting',
        expected: 'alerts [none]',
        actual: describeRun(runs.baseline),
        ok: runs.baseline.alerts.length === 0,
      })

      runs.unchanged = await monitor(ctx, state)
      checks.push({
        name: 'no restart: no alert',
        expected: 'alerts [none]',
        actual: describeRun(runs.unchanged),
        ok: runs.unchanged.alerts.length === 0,
        severity: 'high',
      })

      ctx.log('graceful restart (docker compose restart app)')
      await ctx.docker.app.restart(ctx.baseUrl)
      runs.graceful = await monitor(ctx, state)
      const g = runs.graceful.alerts[0]
      checks.push({
        name: 'graceful restart: one restart alert, lastShutdown graceful, no label',
        expected: `alerts [restart] lastShutdown=graceful from ${h?.bootId}`,
        actual: describeRun(runs.graceful),
        ok:
          kinds(runs.graceful) === 'restart' &&
          g?.lastShutdown === 'graceful' &&
          // previousBootId on /health chains to the process the monitor saw.
          g.unseen === false &&
          g.previousBootId === h?.bootId &&
          g.previous?.bootId === h?.bootId &&
          g.current?.bootId !== h?.bootId &&
          runs.graceful.labels.length === 0,
        severity: 'high',
      })

      ctx.log('unclean restart (SIGKILL)')
      await ctx.docker.app.crash(ctx.baseUrl)
      runs.unclean = await monitor(ctx, state)
      const u = runs.unclean.alerts[0]
      checks.push({
        name: 'SIGKILL restart: one restart alert, lastShutdown unclean, label unclean-restart',
        expected: 'alerts [restart] lastShutdown=unclean labels [unclean-restart]',
        actual: describeRun(runs.unclean),
        ok:
          kinds(runs.unclean) === 'restart' &&
          u?.lastShutdown === 'unclean' &&
          u.unseen === false &&
          u.previous?.bootId === g?.current?.bootId &&
          runs.unclean.labels.join(',') === 'unclean-restart',
        severity: 'high',
      })

      runs.afterUnclean = await monitor(ctx, state)
      checks.push({
        name: 'a restart is reported once',
        expected: 'alerts [none]',
        actual: describeRun(runs.afterUnclean),
        ok: runs.afterUnclean.alerts.length === 0,
        severity: 'high',
      })

      ctx.log('app stopped for three checks')
      await ctx.docker.app.stop()
      try {
        runs.down1 = await monitor(ctx, state)
        runs.down2 = await monitor(ctx, state)
        runs.down3 = await monitor(ctx, state)
      } finally {
        await ctx.docker.app.start()
        await ctx.docker.waitHealthy(ctx.baseUrl)
      }
      checks.push({
        name: 'down: one alert after two failed checks, none on the third',
        expected: 'alerts [none], [down], [none]',
        actual: `${describeRun(runs.down1)}; ${describeRun(runs.down2)}; ${describeRun(runs.down3)} (error: ${runs.down1.observation.error})`,
        ok: kinds(runs.down1) === 'none' && kinds(runs.down2) === 'down' && kinds(runs.down3) === 'none',
        severity: 'high',
      })

      runs.recovered = await monitor(ctx, state)
      const r = runs.recovered.alerts.find((a) => a.kind === 'restart')
      checks.push({
        name: 'recovery: one recovered alert with the restart (compose stop is graceful)',
        expected: 'alerts [recovered,restart] lastShutdown=graceful',
        actual: describeRun(runs.recovered),
        ok: kinds(runs.recovered) === 'recovered,restart' && r?.lastShutdown === 'graceful' && r.unseen === false,
        severity: 'high',
      })

      const bootId = runs.recovered.observation.health?.bootId
      const bootLines = (await ctx.docker.app.logs('app', 2000))
        .split('\n')
        .map((l) => l.slice(l.indexOf('{')))
        .filter((l) => l.startsWith('{"event":"boot"'))
      const current = bootLines.find((l) => l.includes(`"bootId":"${bootId}"`))
      checks.push({
        name: 'boot logs one structured line with the previous shutdown',
        expected: `a {"event":"boot"} line for ${bootId} with lastShutdown graceful and the previous bootId`,
        actual: current ?? `${bootLines.length} boot line(s), none for ${bootId}`,
        ok: !!current && current.includes('"lastShutdown":"graceful"') && current.includes(`"previous":{"bootId":"${r?.previous?.bootId}"`),
        severity: 'medium',
      })

      return {
        summary:
          `Monitor runs: baseline [${kinds(runs.baseline)}], unchanged [${kinds(runs.unchanged)}], graceful restart [${describeRun(runs.graceful)}], ` +
          `SIGKILL [${describeRun(runs.unclean)}], stopped x3 [${kinds(runs.down1)}; ${kinds(runs.down2)}; ${kinds(runs.down3)}], started [${describeRun(runs.recovered)}].`,
        checks,
        data: { runs, bootLines },
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
}
export default test
