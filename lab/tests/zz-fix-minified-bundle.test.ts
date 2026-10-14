// PR #405 (fix/extraction-queue-stall), stall half: on dev one minified
// bundle becomes ~1 symbol per declaration, all on one huge line, and
// server/src/search/embeddings.ts embeds the file + every symbol in ONE ONNX
// run padded to 512 tokens (PR measured 30.7 GB RSS for a 742 KB bundle).
// The serial in-memory queue (extraction-queue.ts) then either crawls or the
// process dies and every file queued behind the bundle is lost.
// #405: lines > 1000 chars mark a file minified (no symbols/imports, file
// embedding only), embeddings run in batches of 8, inputs capped at 16k chars.
//
// Method: local_path repo = BUNDLE (~700 KB, ~900 function/class
// declarations on one line) + 2 small files; once the first sync stored them,
// LATE small TS files are added to the folder, so the watcher queues them
// BEHIND the bundle. `docker stats`/`docker inspect`/health sampled every 2 s.
// Named zz- so it runs last: on dev it may take the instance down.
import type { Check, LabTest } from '../lib/context.ts'
import {
  connectLocalRepo,
  containerState,
  copyIntoLocalRepo,
  filesPendingExtraction,
  repoProgress,
  settleRepo,
  sqlPending,
  startSampler,
  summarizeSamples,
  writeTree,
} from '../lib/fixlab.ts'

const DECLS = Number(process.env.LAB_BUNDLE_DECLS ?? 900)
const TARGET_BYTES = Number(process.env.LAB_BUNDLE_BYTES ?? 700_000)
const LATE = Number(process.env.LAB_BUNDLE_LATE_FILES ?? 30)
const TIMEOUT_MS = Number(process.env.LAB_BUNDLE_TIMEOUT_MS ?? 25 * 60_000)
const STALL_MS = Number(process.env.LAB_BUNDLE_STALL_MS ?? 240_000)

/** esbuild-style output: every declaration on one line, padded to TARGET_BYTES. */
function makeBundle(): string {
  const per = Math.floor(TARGET_BYTES / DECLS)
  const parts: string[] = ['"use strict";']
  for (let i = 0; i < DECLS; i++) {
    const head =
      i % 10 === 9
        ? `class C${i}{constructor(e){this.v=e}run(t){return this.v+t+"`
        : `function a${i}(e,t){var n=e+t|0;for(var r=0;r<n;r++)n^=r<<${i % 7};return n+"`
    const tail = i % 10 === 9 ? `"}}` : `"}`
    const padLen = Math.max(8, per - head.length - tail.length)
    parts.push(head + `k${i}_`.repeat(Math.ceil(padLen / 6)).slice(0, padLen) + tail)
  }
  return parts.join('') + '\nexport{a0 as run};\n'
}

function smallTs(prefix: string, i: number): string {
  return `export function ${prefix}Fn${i}(x: number): number {\n  return x * ${i}\n}\n\nexport class ${prefix}Cls${i} {\n  go() {\n    return ${prefix}Fn${i}(2)\n  }\n}\n`
}

const test: LabTest = {
  name: 'zz-fix-minified-bundle',
  description: 'PR #405: a 700 KB / 900-declaration minified bundle neither OOMs/restarts the app nor blocks files queued after it.',
  async run(ctx) {
    const checks: Check[] = []
    const bundle = makeBundle()
    const name = ctx.uniq('fix-bundle')
    const early: Record<string, string> = { 'cli.bundle.mjs': bundle, 'src/early0.ts': smallTs('early', 0), 'src/early1.ts': smallTs('early', 1) }
    const late: Record<string, string> = {}
    for (let i = 0; i < LATE; i++) late[`src/late${String(i).padStart(2, '0')}.ts`] = smallTs('late', i)

    const containerId = (await ctx.docker.compose('ps', '-q', 'app')).stdout.trim()
    const stateBefore = await containerState(ctx, containerId)
    const sampler = startSampler(ctx, containerId)

    await copyIntoLocalRepo(ctx, writeTree(early), name)
    const repo = await connectLocalRepo(ctx, name)
    // Wait until the first sync stored the early files (they are now queued, bundle among them).
    let p = await repoProgress(ctx, repo.id)
    const t0 = Date.now()
    while (p.files < 3 && Date.now() - t0 < 120_000) {
      // Real time on purpose: waiting on a live sync.
      await Bun.sleep(500)
      p = await repoProgress(ctx, repo.id).catch(() => p)
    }
    const lateAddedAt = Math.round((Date.now() - ctx.startedAt) / 1000)
    await copyIntoLocalRepo(ctx, writeTree(late), name)
    ctx.log(`late files added at +${lateAddedAt}s (early files stored: ${p.files})`)

    const settle = await settleRepo(ctx, repo.id, 'bundle', {
      stallMs: STALL_MS,
      timeoutMs: TIMEOUT_MS,
      minFiles: 3 + LATE,
      pollMs: 5_000,
    })
    const samples = await sampler.stop()
    const stats = summarizeSamples(samples)
    const stateAfter = await containerState(ctx, containerId)

    const perFile = await ctx.docker
      .psqlRows<{ path: string; embedded: boolean; symbols: number; imports: number; bytes: number }>(
        `select f.path, (f.embedding is not null) as embedded, length(f.content)::int as bytes,
          (select count(*) from repository_file_symbols s where s.file_id = f.id)::int as symbols,
          (select count(*) from repository_file_imports i where i.source_file_id = f.id)::int as imports
        from repository_files f where f.repository_id = '${repo.id}' order by f.path`,
      )
      .catch(() => [])
    const bundleRow = perFile.find((f) => f.path === 'cli.bundle.mjs')
    const lateRows = perFile.filter((f) => f.path.startsWith('src/late'))
    const lateWithSymbols = lateRows.filter((f) => f.embedded && f.symbols === 2).length
    const pending = await filesPendingExtraction(ctx, repo.id)
    const pendingSql = await sqlPending(ctx, repo.id).catch(() => -1)
    const logs = await ctx.docker.app.logs('app', 400).catch(() => '')
    const notable = logs.split('\n').filter((l) => /heap|out of memory|OOM|Killed|extraction failed|catch-up|FATAL|uncaught/i.test(l)).slice(0, 30)
    const restarted =
      stats.distinctStarts > 1 ||
      (stateBefore && stateAfter ? stateAfter.restartCount !== stateBefore.restartCount || stateAfter.startedAt !== stateBefore.startedAt : false)

    checks.push(
      {
        name: 'app survives indexing the bundle',
        expected: 'no restart, no OOM kill, /health never down',
        actual: `restarted ${restarted} (restartCount ${stateBefore?.restartCount}->${stateAfter?.restartCount}, distinct starts ${stats.distinctStarts}), OOMKilled seen ${stats.oomKilledSeen}, unhealthy samples ${stats.unhealthySamples}/${stats.samples}`,
        ok: !restarted && !stats.oomKilledSeen && stats.unhealthySamples === 0,
        severity: 'critical',
      },
      {
        name: 'app memory stays bounded',
        expected: 'peak app RSS < 3 GiB (docker stats)',
        actual: `peak ${stats.peakMemMiB} MiB`,
        ok: stats.peakMemMiB === null ? null : stats.peakMemMiB < 3072,
        severity: 'high',
      },
      {
        name: 'files queued after the bundle still get extracted',
        expected: `${LATE}/${LATE} late files embedded with 2 symbols each`,
        actual: `${lateWithSymbols}/${lateRows.length} (settle ${settle.outcome} in ${Math.round(settle.ms / 1000)} s)`,
        ok: lateRows.length === LATE && lateWithSymbols === LATE,
        severity: 'critical',
      },
      {
        name: 'bundle itself: file embedding, no junk symbols',
        expected: 'bundle embedded, 0 symbols (minified)',
        actual: bundleRow ? `embedded ${bundleRow.embedded}, ${bundleRow.symbols} symbols, ${bundleRow.bytes} chars` : 'bundle row missing',
        ok: bundleRow ? bundleRow.embedded && bundleRow.symbols === 0 : null,
        severity: 'medium',
      },
      {
        name: 'filesPendingExtraction reaches 0',
        expected: 'repository_status.filesPendingExtraction === 0 and SQL agrees',
        actual: `field ${pending.value === undefined ? `absent/failed (${pending.raw.slice(0, 120)})` : pending.value}; SQL pending ${pendingSql}`,
        ok: pending.value === 0 && pendingSql === 0,
        severity: 'medium',
      },
    )

    return {
      summary:
        `Bundle ${bundle.length} bytes, ${DECLS} declarations on one line, + ${LATE} TS files added behind it. ` +
        `Settle ${settle.outcome} after ${Math.round(settle.ms / 1000)} s; peak app memory ${stats.peakMemMiB} MiB; restarted ${restarted}; OOMKilled ${stats.oomKilledSeen}; ` +
        `late files extracted ${lateWithSymbols}/${LATE}; bundle symbols ${bundleRow?.symbols ?? 'n/a'}; filesPendingExtraction ${pending.value ?? 'absent'} (SQL ${pendingSql}).`,
      checks,
      data: {
        repoId: repo.id,
        bundleBytes: bundle.length,
        decls: DECLS,
        lateAddedAt,
        stateBefore,
        stateAfter,
        stats,
        samples,
        settle: { outcome: settle.outcome, ms: settle.ms },
        timeline: settle.timeline,
        perFile,
        pending,
        pendingSql,
        notableLogLines: notable,
      },
    }
  },
}
export default test
