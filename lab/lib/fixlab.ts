// Helpers shared by the fix-validation tests (lab/tests/fix-*.test.ts,
// zz-fix-*.test.ts): repository progress from Postgres, settle loops,
// local_path repositories built on the runner and copied into the app
// container, and a docker stats/restart sampler for the app container.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LabContext } from './context.ts'
import { containerState } from './docker.ts'

export interface RepoProgress {
  t: number
  status: string
  lastSyncError: string | null
  files: number
  embedded: number
  symbols: number
}

export async function repoProgress(ctx: LabContext, repoId: string): Promise<RepoProgress> {
  const [row] = await ctx.docker.psqlRows<Omit<RepoProgress, 't'>>(`
    select r.sync_status as "status", r.last_sync_error as "lastSyncError",
      (select count(*) from repository_files f where f.repository_id = r.id)::int as "files",
      (select count(*) from repository_files f where f.repository_id = r.id and f.embedding is not null)::int as "embedded",
      (select count(*) from repository_file_symbols s join repository_files f on f.id = s.file_id
        where f.repository_id = r.id)::int as "symbols"
    from repositories r where r.id = '${repoId}'`)
  if (!row) throw new Error(`repository ${repoId} not found`)
  return { t: Math.round((Date.now() - ctx.startedAt) / 1000), ...row }
}

/**
 * Polls until every file is embedded, or nothing moved for `stallMs`, or
 * `timeoutMs` passed. A failing psql (db or app down) is recorded, not thrown.
 */
export async function settleRepo(
  ctx: LabContext,
  repoId: string,
  label: string,
  opts: { stallMs: number; timeoutMs: number; pollMs?: number; minFiles?: number },
): Promise<{ timeline: RepoProgress[]; outcome: 'complete' | 'stalled' | 'timeout'; ms: number }> {
  const timeline: RepoProgress[] = []
  const t0 = Date.now()
  let lastChange = Date.now()
  for (;;) {
    let p: RepoProgress | undefined
    try {
      p = await repoProgress(ctx, repoId)
    } catch (err) {
      ctx.log(`${label}: progress query failed: ${String(err).slice(0, 200)}`)
    }
    if (p) {
      const prev = timeline.at(-1)
      if (!prev || prev.embedded !== p.embedded || prev.files !== p.files || prev.status !== p.status || prev.symbols !== p.symbols)
        lastChange = Date.now()
      timeline.push(p)
      const enoughFiles = p.files > 0 && p.files >= (opts.minFiles ?? 1)
      if (p.status !== 'syncing' && enoughFiles && p.embedded === p.files) {
        ctx.log(`${label}: complete files=${p.files} symbols=${p.symbols}`)
        return { timeline, outcome: 'complete', ms: Date.now() - t0 }
      }
      if (p.status !== 'syncing' && Date.now() - lastChange >= opts.stallMs) {
        ctx.log(`${label}: stalled status=${p.status} files=${p.files} embedded=${p.embedded} symbols=${p.symbols}`)
        return { timeline, outcome: 'stalled', ms: Date.now() - t0 }
      }
      if (timeline.length % 12 === 0) ctx.log(`${label}: status=${p.status} files=${p.files} embedded=${p.embedded}`)
    }
    if (Date.now() - t0 > opts.timeoutMs) {
      ctx.log(`${label}: timeout`)
      return { timeline, outcome: 'timeout', ms: Date.now() - t0 }
    }
    // Real time on purpose: this polls a live server's background queue.
    await Bun.sleep(opts.pollMs ?? 3_000)
  }
}

/** Writes `files` (path -> content) under a fresh runner temp dir; returns it. */
export function writeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lab-tree-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

export const LOCAL_REPOS_ROOT = '/data/elara/local-repos'

/** Copies a runner dir's CONTENTS into LOCAL_REPOS_ROOT/<name> inside the app container. */
export async function copyIntoLocalRepo(ctx: LabContext, hostDir: string, name: string): Promise<void> {
  await ctx.docker.compose('exec', '-T', 'app', 'mkdir', '-p', `${LOCAL_REPOS_ROOT}/${name}`)
  await ctx.docker.compose('cp', `${hostDir}/.`, `app:${LOCAL_REPOS_ROOT}/${name}`)
}

/** Connects a local_path repository (path relative to LOCAL_REPOS_ROOT). */
export async function connectLocalRepo(ctx: LabContext, name: string): Promise<{ id: string; name: string }> {
  return ctx.rest('admin').must('POST', '/api/repositories', { name, ingestionMethod: 'local_path', localPath: name })
}

export interface StatsSample {
  t: number
  memBytes: number | null
  memRaw: string
  cpu: string
  healthy: boolean
  restartCount: number | null
  oomKilled: boolean | null
  startedAt: string | null
}

const UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, kB: 1e3, MB: 1e6, GB: 1e9 }

function parseMem(raw: string): number | null {
  const m = raw.split('/')[0]?.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/)
  if (!m) return null
  const unit = UNITS[m[2]!]
  return unit ? Number(m[1]) * unit : null
}

/**
 * Samples `docker stats --no-stream`, `docker inspect` and GET /health for the
 * app container every `everyMs` until stop() is called. Never throws.
 */
export function startSampler(ctx: LabContext, id: string, everyMs = 2_000) {
  const samples: StatsSample[] = []
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      const t = Math.round((Date.now() - ctx.startedAt) / 1000)
      const [stats, state, healthy] = await Promise.all([
        ctx.docker.exec(['docker', 'stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', id]),
        containerState(id),
        fetch(`${ctx.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) })
          .then((r) => r.ok)
          .catch(() => false),
      ])
      const [memRaw = '', cpu = ''] = stats.stdout.trim().split('|')
      samples.push({
        t,
        memBytes: parseMem(memRaw),
        memRaw,
        cpu,
        healthy,
        restartCount: state?.restartCount ?? null,
        oomKilled: state?.oomKilled ?? null,
        startedAt: state?.startedAt ?? null,
      })
      await Bun.sleep(everyMs)
    }
  })()
  return {
    samples,
    async stop() {
      stopped = true
      await loop
      return samples
    },
  }
}

export function summarizeSamples(samples: StatsSample[]) {
  const mems = samples.map((s) => s.memBytes).filter((m): m is number => m !== null)
  const startedAts = new Set(samples.map((s) => s.startedAt).filter(Boolean))
  return {
    samples: samples.length,
    peakMemMiB: mems.length ? Math.round(Math.max(...mems) / 1024 ** 2) : null,
    unhealthySamples: samples.filter((s) => !s.healthy).length,
    /** Distinct container start times seen: >1 means the app process restarted. */
    distinctStarts: startedAts.size,
    restartCountFirst: samples[0]?.restartCount ?? null,
    restartCountLast: samples.at(-1)?.restartCount ?? null,
    oomKilledSeen: samples.some((s) => s.oomKilled === true),
  }
}

/** `repository_status.filesPendingExtraction` (added by #405); undefined when the field is absent. */
export async function filesPendingExtraction(ctx: LabContext, repoId: string) {
  const r = await ctx.mcp('adminAccount').call('repository_status', { repositoryId: repoId })
  const json = r.json as Record<string, unknown> | undefined
  const v = json?.filesPendingExtraction
  return { ok: r.ok, value: typeof v === 'number' ? v : undefined, raw: r.text.slice(0, 400) }
}

/**
 * Files without an embedding. Not quite filesPendingExtraction: the field
 * counts a file whose extract job is not done, and a file gets its embedding
 * before its job completes (semantic edges come in between), so the field can
 * be higher until that job finishes or a dead process's lease runs out (#845).
 */
export async function sqlPending(ctx: LabContext, repoId: string): Promise<number> {
  return Number(
    await ctx.docker.psql(`select count(*) from repository_files where repository_id = '${repoId}' and embedding is null;`),
  )
}

/**
 * Polls filesPendingExtraction and sqlPending until both are 0 or `timeoutMs`
 * passed; returns the last values and how long it waited. A failing psql
 * reads as -1.
 */
export async function waitPendingZero(ctx: LabContext, repoId: string, timeoutMs: number, pollMs = 2_000) {
  const t0 = Date.now()
  for (let polls = 1; ; polls++) {
    const field = await filesPendingExtraction(ctx, repoId)
    const sql = await sqlPending(ctx, repoId).catch(() => -1)
    const waitedMs = Date.now() - t0
    const settled = field.value === 0 && sql === 0
    if (settled || waitedMs >= timeoutMs) return { settled, field, sql, waitedMs, polls }
    // Real time on purpose: a crashed job is claimable again only when its lease runs out.
    await Bun.sleep(pollMs)
  }
}
