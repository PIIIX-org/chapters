// Does restarting the app while a repository is being indexed lose work?
// server/src/repositories/extraction-queue.ts keeps the per-file
// extraction + embedding queue in process memory, and store.ts only
// schedules files whose content hash changed. Hypothesis: a restart
// mid-extraction leaves files permanently without symbols/embeddings, and a
// later sync does not repair them (hashes unchanged).
//
// Method (ground truth from Postgres, not from MCP):
//   clean    connect REPO, wait until extraction settles, measure per file
//   restart  connect REPO again under another name, wait until RESTART_AT of
//            its files are embedded, `docker compose restart app` (graceful
//            SIGTERM), wait until it settles, measure
//   resync   POST /api/repositories/:id/sync on the restarted copy, settle, measure
//   during-sync  connect REPO a third time, restart immediately (first sync
//            still cloning/inserting), then POST /sync, settle, measure
// "Settled" = sync_status is not 'syncing' and the embedded-file count has
// not moved for STALL_MS (or every file is embedded).
import type { Check, LabContext, LabTest } from '../lib/context.ts'

const REPO_URL = process.env.LAB_RESTART_REPO_URL ?? 'https://github.com/PIIIX-org/chapters'
const RESTART_AT = Number(process.env.LAB_RESTART_AT ?? 0.25)
const STALL_MS = Number(process.env.LAB_RESTART_STALL_MS ?? 120_000)
const SETTLE_TIMEOUT_MS = Number(process.env.LAB_RESTART_SETTLE_TIMEOUT_MS ?? 45 * 60_000)

interface FileRow {
  path: string
  language: string | null
  embedded: boolean
  symbols: number
}

interface Progress {
  t: number
  status: string
  lastSyncedAt: string | null
  lastSyncError: string | null
  files: number
  embedded: number
  symbols: number
}

async function progress(ctx: LabContext, repoId: string): Promise<Progress> {
  const [row] = await ctx.docker.psqlRows<Omit<Progress, 't'>>(`
    select r.sync_status as "status", r.last_synced_at as "lastSyncedAt", r.last_sync_error as "lastSyncError",
      (select count(*) from repository_files f where f.repository_id = r.id)::int as "files",
      (select count(*) from repository_files f where f.repository_id = r.id and f.embedding is not null)::int as "embedded",
      (select count(*) from repository_file_symbols s join repository_files f on f.id = s.file_id
        where f.repository_id = r.id)::int as "symbols"
    from repositories r where r.id = '${repoId}'`)
  if (!row) throw new Error(`repository ${repoId} not found`)
  return { t: Math.round((Date.now() - ctx.startedAt) / 1000), ...row }
}

async function perFile(ctx: LabContext, repoId: string): Promise<FileRow[]> {
  return ctx.docker.psqlRows<FileRow>(`
    select f.path, f.language, (f.embedding is not null) as embedded,
      (select count(*) from repository_file_symbols s where s.file_id = f.id)::int as symbols
    from repository_files f where f.repository_id = '${repoId}' order by f.path`)
}

/** Polls until settled; returns the timeline (one point per poll). */
async function settle(ctx: LabContext, repoId: string, label: string): Promise<Progress[]> {
  const timeline: Progress[] = []
  let lastChange = Date.now()
  const t0 = Date.now()
  for (;;) {
    const p = await progress(ctx, repoId)
    const prev = timeline.at(-1)
    if (!prev || prev.embedded !== p.embedded || prev.files !== p.files || prev.status !== p.status) lastChange = Date.now()
    timeline.push(p)
    const done = p.status !== 'syncing' && p.files > 0 && (p.embedded === p.files || Date.now() - lastChange >= STALL_MS)
    const failed = p.status === 'error' && Date.now() - lastChange >= STALL_MS
    if (done || failed) {
      ctx.log(`${label}: settled status=${p.status} files=${p.files} embedded=${p.embedded} symbols=${p.symbols}`)
      return timeline
    }
    if (Date.now() - t0 > SETTLE_TIMEOUT_MS) {
      ctx.log(`${label}: settle timeout`)
      return timeline
    }
    if (timeline.length % 12 === 0) ctx.log(`${label}: status=${p.status} files=${p.files} embedded=${p.embedded}`)
    // Real time on purpose: this polls a live server's background queue.
    await Bun.sleep(5_000)
  }
}

function compare(clean: FileRow[], other: FileRow[]) {
  const byPath = new Map(other.map((f) => [f.path, f]))
  const lostEmbedding = clean.filter((f) => f.embedded && !byPath.get(f.path)?.embedded).map((f) => f.path)
  const lostSymbols = clean.filter((f) => f.symbols > 0 && (byPath.get(f.path)?.symbols ?? 0) === 0).map((f) => f.path)
  const sum = (rows: FileRow[]) => rows.reduce((n, f) => n + f.symbols, 0)
  return {
    files: other.length,
    embedded: other.filter((f) => f.embedded).length,
    filesWithSymbols: other.filter((f) => f.symbols > 0).length,
    symbols: sum(other),
    lostEmbedding: lostEmbedding.length,
    lostSymbols: lostSymbols.length,
    lostSymbolsSample: lostSymbols.slice(0, 25),
  }
}

const test: LabTest = {
  name: 'restart-extraction',
  description: 'Restart the app mid-extraction; compare per-file symbol/embedding coverage with a clean run, then after a re-sync.',
  async run(ctx) {
    const checks: Check[] = []
    const admin = ctx.rest('admin')

    // ---- clean run
    const cleanRepo = await ctx.connectRepo('admin', ctx.uniq('lab-clean'), REPO_URL)
    const cleanT0 = Date.now()
    const cleanTimeline = await settle(ctx, cleanRepo.id, 'clean')
    const cleanMs = Date.now() - cleanT0
    const clean = await perFile(ctx, cleanRepo.id)
    const cleanStats = compare(clean, clean)

    // ---- restart run
    const restartRepo = await ctx.connectRepo('admin', ctx.uniq('lab-restart'), REPO_URL)
    let atRestart: Progress | undefined
    const waitT0 = Date.now()
    for (;;) {
      const p = await progress(ctx, restartRepo.id)
      if (p.files > 0 && p.embedded >= p.files * RESTART_AT) {
        atRestart = p
        break
      }
      if (p.status === 'error' || Date.now() - waitT0 > SETTLE_TIMEOUT_MS) throw new Error(`never reached restart point: ${JSON.stringify(p)}`)
      // Real time on purpose: catching a live queue mid-way.
      await Bun.sleep(1_000)
    }
    ctx.log(`restarting app at embedded=${atRestart.embedded}/${atRestart.files} status=${atRestart.status}`)
    const restart = await ctx.docker.app.restart(ctx.baseUrl)
    const afterRestartTimeline = await settle(ctx, restartRepo.id, 'after-restart')
    const afterRestart = await perFile(ctx, restartRepo.id)
    const afterRestartStats = compare(clean, afterRestart)
    const statusAfterRestart = afterRestartTimeline.at(-1)!

    // ---- re-sync the restarted copy (what the poller / a webhook / sync_repository would do)
    const sync = await admin.post(`/api/repositories/${restartRepo.id}/sync`, {})
    const resyncTimeline = await settle(ctx, restartRepo.id, 'after-resync')
    const afterResync = await perFile(ctx, restartRepo.id)
    const afterResyncStats = compare(clean, afterResync)

    // ---- restart during the FIRST sync (clone/insert), then a manual sync
    const syncRepo = await ctx.connectRepo('admin', ctx.uniq('lab-restart-sync'), REPO_URL)
    const atSyncRestart = await progress(ctx, syncRepo.id)
    ctx.log(`restarting app during first sync: ${JSON.stringify(atSyncRestart)}`)
    const syncRestart = await ctx.docker.app.restart(ctx.baseUrl)
    const afterSyncRestart = await progress(ctx, syncRepo.id)
    const manualSync = await admin.post(`/api/repositories/${syncRepo.id}/sync`, {})
    const duringSyncTimeline = await settle(ctx, syncRepo.id, 'during-sync+manual-sync')
    const duringSyncStats = compare(clean, await perFile(ctx, syncRepo.id))

    const appLogs = await ctx.docker.app.logs('app', 400)
    const errorLines = appLogs.split('\n').filter((l) => /error|ENOENT|unhandled/i.test(l)).slice(0, 40)

    checks.push(
      {
        name: 'clean run indexes every file',
        expected: `embedded == files (${cleanStats.files})`,
        actual: `embedded ${cleanStats.embedded}, files with symbols ${cleanStats.filesWithSymbols}, symbols ${cleanStats.symbols}, ${Math.round(cleanMs / 1000)} s`,
        ok: cleanStats.embedded === cleanStats.files,
        severity: 'medium',
      },
      {
        name: 'restart mid-extraction: embeddings not lost',
        expected: '0 files embedded in the clean run but not after restart',
        actual: `${afterRestartStats.lostEmbedding} lost (embedded ${afterRestartStats.embedded}/${afterRestartStats.files}; restart at ${atRestart.embedded}/${atRestart.files})`,
        ok: afterRestartStats.lostEmbedding === 0,
        severity: 'high',
      },
      {
        name: 'restart mid-extraction: symbols not lost',
        expected: '0 files with symbols in the clean run but none after restart',
        actual: `${afterRestartStats.lostSymbols} files lost all symbols (symbols ${afterRestartStats.symbols} vs clean ${cleanStats.symbols})`,
        ok: afterRestartStats.lostSymbols === 0,
        severity: 'high',
      },
      {
        name: 'restart: repository not stuck',
        expected: "sync_status 'idle' after restart",
        actual: `${statusAfterRestart.status}${statusAfterRestart.lastSyncError ? ` (${statusAfterRestart.lastSyncError})` : ''}`,
        ok: statusAfterRestart.status === 'idle',
        severity: 'medium',
      },
      {
        name: 're-sync repairs the lost extraction',
        expected: '0 lost after POST /sync',
        actual: `sync HTTP ${sync.status}; ${afterResyncStats.lostEmbedding} embeddings / ${afterResyncStats.lostSymbols} symbol files still lost`,
        ok: afterResyncStats.lostEmbedding === 0 && afterResyncStats.lostSymbols === 0,
        severity: 'high',
      },
      {
        name: 'restart during first sync: not stuck in syncing',
        expected: "sync_status != 'syncing' after restart (boot reconciliation)",
        actual: `at restart ${atSyncRestart.status} files=${atSyncRestart.files}; after ${afterSyncRestart.status}${afterSyncRestart.lastSyncError ? ` (${afterSyncRestart.lastSyncError})` : ''}`,
        ok: afterSyncRestart.status !== 'syncing',
        severity: 'medium',
      },
      {
        name: 'restart during first sync: manual sync then indexes everything',
        expected: '0 lost vs clean',
        actual: `sync HTTP ${manualSync.status}; embedded ${duringSyncStats.embedded}/${duringSyncStats.files}; ${duringSyncStats.lostEmbedding} embeddings / ${duringSyncStats.lostSymbols} symbol files lost`,
        ok: duringSyncStats.lostEmbedding === 0 && duringSyncStats.lostSymbols === 0 && duringSyncStats.files === cleanStats.files,
        severity: 'high',
      },
    )

    return {
      summary:
        `Repo ${REPO_URL}. Clean: ${cleanStats.embedded}/${cleanStats.files} files embedded, ${cleanStats.symbols} symbols in ${Math.round(cleanMs / 1000)} s. ` +
        `Restarted at ${atRestart.embedded}/${atRestart.files} embedded: after settling ${afterRestartStats.embedded}/${afterRestartStats.files} embedded, ` +
        `${afterRestartStats.lostSymbols} files lost all symbols, status ${statusAfterRestart.status}. ` +
        `After re-sync: ${afterResyncStats.lostEmbedding} embeddings and ${afterResyncStats.lostSymbols} symbol files still missing. ` +
        `Restart during first sync (caught at status ${atSyncRestart.status}, ${atSyncRestart.files} files) -> ${afterSyncRestart.status}; after manual sync ${duringSyncStats.embedded}/${duringSyncStats.files} embedded, ${duringSyncStats.lostSymbols} symbol files lost.`,
      checks,
      data: {
        repoUrl: REPO_URL,
        restartAt: RESTART_AT,
        stallMs: STALL_MS,
        cleanRepoId: cleanRepo.id,
        restartRepoId: restartRepo.id,
        cleanMs,
        clean: cleanStats,
        atRestart,
        restart,
        afterRestart: afterRestartStats,
        afterResync: { syncHttp: sync.status, syncBody: sync.text.slice(0, 300), ...afterResyncStats },
        duringSync: {
          repoId: syncRepo.id,
          atRestart: atSyncRestart,
          restart: syncRestart,
          afterRestart: afterSyncRestart,
          manualSync: { http: manualSync.status, body: manualSync.text.slice(0, 300) },
          ...duringSyncStats,
        },
        timelines: { clean: cleanTimeline, afterRestart: afterRestartTimeline, afterResync: resyncTimeline, duringSync: duringSyncTimeline },
        appErrorLines: errorLines,
      },
    }
  },
}
export default test
