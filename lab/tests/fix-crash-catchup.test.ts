// PR #405 (fix/extraction-queue-stall), boot catch-up half: the extraction
// queue lives in process memory (server/src/repositories/extraction-queue.ts),
// and a re-sync only re-enqueues files whose content hash changed, so files
// queued when the process died were never extracted on dev. #405 re-queues
// every file without an embedding at boot (scheduleMissingExtractions) and
// exposes the backlog as repository_status.filesPendingExtraction.
//
// Method: local_path repo of FILES small TS files, wait until CRASH_AT of
// them are embedded, SIGKILL the app (crash, no graceful shutdown), start it,
// and — without any sync — wait for the backlog. Ground truth from Postgres.
//
// A file gets its embedding before its extract job completes (semantic edges
// run in between). A SIGKILL in that gap leaves a file the SQL count calls
// done and a job still pending under the dead process's lease, claimable
// again only when the lease runs out (server jobTiming.leaseMs 60 s, woken
// every pollMs 5 s), so filesPendingExtraction stays at 1 for up to about a
// minute after the SQL count is 0 (#845). The last check therefore waits up
// to PENDING_SETTLE_MS for both to be 0.
import type { Check, LabTest } from '../lib/context.ts'
import { connectLocalRepo, copyIntoLocalRepo, filesPendingExtraction, repoProgress, settleRepo, waitPendingZero, writeTree } from '../lib/fixlab.ts'

const FILES = Number(process.env.LAB_CATCHUP_FILES ?? 300)
const CRASH_AT = Number(process.env.LAB_CATCHUP_CRASH_AT ?? 0.2)
/** Lease (60 s) + drainer poll (5 s) + the re-run of the reclaimed file, with margin. */
const PENDING_SETTLE_MS = 120_000

const test: LabTest = {
  name: 'fix-crash-catchup',
  tier: 'fast',
  description: 'PR #405: SIGKILL mid-extraction; boot catch-up must extract the lost backlog without a re-sync; filesPendingExtraction -> 0.',
  async run(ctx) {
    const checks: Check[] = []
    const files: Record<string, string> = {}
    for (let i = 0; i < FILES; i++) {
      files[`src/f${String(i).padStart(4, '0')}.ts`] =
        `export function alpha${i}(x: number): number {\n  return x + ${i}\n}\n\nexport class Beta${i} {\n  run() {\n    return alpha${i}(1)\n  }\n}\n\nexport function gamma${i}() {\n  return new Beta${i}().run()\n}\n`
    }
    const name = ctx.uniq('fix-catchup')
    await copyIntoLocalRepo(ctx, writeTree(files), name)
    const repo = await connectLocalRepo(ctx, name)

    let atCrash = await repoProgress(ctx, repo.id)
    const t0 = Date.now()
    while (!(atCrash.files === FILES && atCrash.embedded >= FILES * CRASH_AT)) {
      if (Date.now() - t0 > 20 * 60_000 || atCrash.status === 'error') throw new Error(`never reached crash point: ${JSON.stringify(atCrash)}`)
      // Real time on purpose: catching a live queue mid-way.
      await Bun.sleep(500)
      atCrash = await repoProgress(ctx, repo.id)
    }
    ctx.log(`SIGKILL at embedded=${atCrash.embedded}/${atCrash.files}`)
    const crash = await ctx.docker.app.crash(ctx.baseUrl)
    const afterBoot = await repoProgress(ctx, repo.id)
    const pendingAfterBoot = await filesPendingExtraction(ctx, repo.id)

    const settle = await settleRepo(ctx, repo.id, 'after-crash', { stallMs: 90_000, timeoutMs: 20 * 60_000 })
    const final = settle.timeline.at(-1) ?? afterBoot
    const pending = await waitPendingZero(ctx, repo.id, PENDING_SETTLE_MS)
    const pendingFinal = pending.field
    const sqlPendingFinal = pending.sql
    const waited = `after ${Math.round(pending.waitedMs / 1000)} s (${pending.polls} poll(s), bound ${PENDING_SETTLE_MS / 1000} s)`
    const pendingJobs = pending.settled
      ? []
      : await ctx.docker
          .psqlRows(`select f.path, j.attempts, j.lease_until, j.done_at, j.last_error from repository_files f
            join jobs j on j.idempotency_key = 'extract:' || f.id || ':' || f.content_hash
            where f.repository_id = '${repo.id}' and j.done_at is null order by f.path limit 5`)
          .catch((e: unknown) => [{ error: String(e).slice(0, 300) }])
    const noSymbols = Number(
      await ctx.docker.psql(`select count(*) from repository_files f where f.repository_id = '${repo.id}'
        and not exists (select 1 from repository_file_symbols s where s.file_id = f.id);`),
    )
    const bootLog = (await ctx.docker.app.logs('app', 300)).split('\n').filter((l) => /extraction catch-up|reconciled|extraction failed/.test(l)).slice(0, 20)

    checks.push(
      {
        name: 'crash mid-extraction: backlog extracted without a re-sync',
        expected: `${FILES}/${FILES} files embedded after boot, no sync call`,
        actual: `${final.embedded}/${final.files} embedded (crash at ${atCrash.embedded}, right after boot ${afterBoot.embedded}), settle ${settle.outcome} in ${Math.round(settle.ms / 1000)} s`,
        ok: final.embedded === FILES && final.files === FILES,
        severity: 'high',
      },
      {
        name: 'crash mid-extraction: every file has symbols',
        expected: '0 files without symbols (each file declares 3)',
        actual: `${noSymbols} files without symbols; ${final.symbols} symbols total (expected ${FILES * 3})`,
        ok: noSymbols === 0 && final.symbols === FILES * 3,
        severity: 'high',
      },
      {
        name: 'repository_status reports the backlog right after boot',
        expected: `filesPendingExtraction ≈ ${FILES - afterBoot.embedded} right after boot`,
        actual: pendingAfterBoot.value === undefined ? `field absent (${pendingAfterBoot.raw.slice(0, 160)})` : String(pendingAfterBoot.value),
        ok: pendingAfterBoot.value === undefined ? false : pendingAfterBoot.value > 0,
        severity: 'low',
      },
      {
        name: 'filesPendingExtraction reaches 0',
        expected: `repository_status.filesPendingExtraction === 0 and SQL agrees, within ${PENDING_SETTLE_MS / 1000} s of every file being embedded`,
        actual: `field ${pendingFinal.value === undefined ? 'absent' : pendingFinal.value}; SQL pending ${sqlPendingFinal} ${waited}`,
        ok: pending.settled,
        severity: 'medium',
      },
    )

    return {
      summary:
        `${FILES}-file local repo, SIGKILL at ${atCrash.embedded}/${FILES} embedded. After boot (no sync): ${final.embedded}/${final.files} embedded, ` +
        `${noSymbols} files without symbols, filesPendingExtraction ${pendingFinal.value ?? 'absent'} (SQL ${sqlPendingFinal}) ${waited}. Boot log: ${bootLog.filter((l) => /catch-up/.test(l)).length} catch-up line(s).`,
      checks,
      data: { repoId: repo.id, files: FILES, atCrash, crash, afterBoot, pendingAfterBoot, settle: { outcome: settle.outcome, ms: settle.ms }, timeline: settle.timeline, pendingFinal, sqlPendingFinal, pendingWaitMs: pending.waitedMs, pendingPolls: pending.polls, pendingJobs, noSymbols, bootLog },
    }
  },
}
export default test
