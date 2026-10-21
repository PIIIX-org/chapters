// Shared body of lab/tests/zz-fix-{minified,pretty}-bundle.test.ts.
//
// PR #405 (fix/extraction-queue-stall), stall half: on dev one bundle
// becomes ~1 symbol per declaration, and server/src/search/embeddings.ts
// embeds the file + every symbol in ONE ONNX run padded to 512 tokens (PR
// measured 30.7 GB RSS for a 742 KB bundle). The serial in-memory queue
// (extraction-queue.ts) then either crawls or the process dies and every
// file queued behind the bundle is lost.
// #405: lines > 1000 chars mark a file minified (no symbols/imports, file
// embedding only), embeddings run in batches of 8, inputs capped at 16k chars.
//   minified  ~900 declarations on one line: the minified guard applies
//   pretty    the same declarations one per line (< 1000 chars each): no
//             guard, so this measures the batched embedder alone on ~900 symbols
// #496: embedding runs in a worker thread (on the main thread each batch held
// /health past its probe on slow runners), and a file embeds at most 256
// symbols; the pretty bundle still stores all ~900, the rest without a vector.
//
// Method: local_path repo = BUNDLE (~700 KB) + BATCH small TS files in the
// same first sync (queue order = directory order, so some land behind the
// bundle); once that sync stored them, LATE more TS files are added to the
// folder (the watcher queues them behind everything). `docker stats`/`docker
// inspect`/health sampled every 2 s; docker events and the kernel log say why
// a process died. Test files are named zz- so they run last: on dev they may
// take the instance down.
import type { Check, LabTest } from './context.ts'
import { appContainerId, containerState } from './docker.ts'
import {
  connectLocalRepo,
  copyIntoLocalRepo,
  filesPendingExtraction,
  repoProgress,
  settleRepo,
  sqlPending,
  startSampler,
  summarizeSamples,
  writeTree,
} from './fixlab.ts'

const DECLS = Number(process.env.LAB_BUNDLE_DECLS ?? 900)
const TARGET_BYTES = Number(process.env.LAB_BUNDLE_BYTES ?? 700_000)
const BATCH = Number(process.env.LAB_BUNDLE_BATCH_FILES ?? 30)
const LATE = Number(process.env.LAB_BUNDLE_LATE_FILES ?? 10)
const TIMEOUT_MS = Number(process.env.LAB_BUNDLE_TIMEOUT_MS ?? 25 * 60_000)
const STALL_MS = Number(process.env.LAB_BUNDLE_STALL_MS ?? 240_000)

/** esbuild-style output, ~TARGET_BYTES: all declarations on one line, or (pretty) one per line. */
function makeBundle(pretty: boolean): string {
  const per = Math.floor(TARGET_BYTES / DECLS)
  const parts: string[] = ['"use strict";']
  for (let i = 0; i < DECLS; i++) {
    const head =
      i % 10 === 9
        ? `class C${i}{constructor(e){this.v=e}run(t){return this.v+t+"`
        : `function a${i}(e,t){var n=e+t|0;for(var r=0;r<n;r++)n^=r<<${i % 7};return n+"`
    const tail = i % 10 === 9 ? `"}}` : `"}`
    const padLen = Math.max(8, per - head.length - tail.length)
    const token = `k${i}_`
    parts.push(
      head +
        token.repeat(Math.ceil(padLen / token.length)).slice(0, padLen) +
        tail,
    )
  }
  return parts.join(pretty ? '\n' : '') + '\nexport{a0 as run};\n'
}

function smallTs(prefix: string, i: number): string {
  return `export function ${prefix}Fn${i}(x: number): number {\n  return x * ${i}\n}\n\nexport class ${prefix}Cls${i} {\n  go() {\n    return ${prefix}Fn${i}(2)\n  }\n}\n`
}

export function bundleTest(pretty: boolean): LabTest {
  const variant = pretty ? 'pretty' : 'minified'
  return {
    name: `zz-fix-${variant}-bundle`,
    // The minified variant guards #405 (one bundle stalled extraction and
    // OOM-killed the app); the pretty one is slow (minutes), so full tier only.
    tier: pretty ? undefined : 'fast',
    description: pretty
      ? 'PR #405: a 700 KB bundle with ~900 declarations one per line (no minified guard): memory, restarts, queue latency, files behind it.'
      : 'PR #405: a 700 KB / 900-declaration minified bundle neither OOMs/restarts the app nor blocks files queued with or after it.',
    async run(ctx) {
      const checks: Check[] = []
      const bundle = makeBundle(pretty)
      const name = ctx.uniq(`fix-bundle-${variant}`)
      const first: Record<string, string> = { 'cli.bundle.mjs': bundle }
      for (let i = 0; i < BATCH; i++)
        first[`src/batch${String(i).padStart(2, '0')}.ts`] = smallTs('batch', i)
      const late: Record<string, string> = {}
      for (let i = 0; i < LATE; i++)
        late[`src/late${String(i).padStart(2, '0')}.ts`] = smallTs('late', i)

      const containerId = await appContainerId()
      const stateBefore = await containerState(containerId)
      const since = new Date().toISOString()
      const sampler = startSampler(ctx, containerId)

      await copyIntoLocalRepo(ctx, writeTree(first), name)
      const repo = await connectLocalRepo(ctx, name)
      // Wait until the first sync stored the batch (bundle and batch files are now queued).
      let p = await repoProgress(ctx, repo.id)
      const t0 = Date.now()
      while (p.files < BATCH + 1 && Date.now() - t0 < 120_000) {
        // Real time on purpose: waiting on a live sync.
        await Bun.sleep(500)
        p = await repoProgress(ctx, repo.id).catch(() => p)
      }
      const lateAddedAt = Math.round((Date.now() - ctx.startedAt) / 1000)
      await copyIntoLocalRepo(ctx, writeTree(late), name)
      ctx.log(
        `late files added at +${lateAddedAt}s (first sync stored ${p.files})`,
      )

      const settle = await settleRepo(ctx, repo.id, 'bundle', {
        stallMs: STALL_MS,
        timeoutMs: TIMEOUT_MS,
        minFiles: 1 + BATCH + LATE,
        pollMs: 5_000,
      })
      const samples = await sampler.stop()
      const stats = summarizeSamples(samples)
      const stateAfter = await containerState(containerId)
      const events = await ctx.docker.exec([
        'docker',
        'events',
        '--since',
        since,
        '--until',
        new Date().toISOString(),
        '--filter',
        `container=${containerId}`,
        '--format',
        '{{.Time}} {{.Action}} exitCode={{index .Actor.Attributes "exitCode"}}',
      ])
      const containerEvents = events.stdout
        .split('\n')
        .filter((l) => /die|oom|kill|start|restart/.test(l))
        .slice(0, 30)
      const dmesg = await ctx.docker.exec(['sudo', 'dmesg', '-T'])
      const kernelOom = dmesg.stdout
        .split('\n')
        .filter((l) => /out of memory|oom-kill|killed process/i.test(l))
        .slice(-10)

      const perFile = await ctx.docker
        .psqlRows<{
          path: string
          embedded: boolean
          symbols: number
          imports: number
          bytes: number
        }>(
          `select f.path, (f.embedding is not null) as embedded, length(f.content)::int as bytes,
          (select count(*) from repository_file_symbols s where s.file_id = f.id)::int as symbols,
          (select count(*) from repository_file_imports i where i.source_file_id = f.id)::int as imports
        from repository_files f where f.repository_id = '${repo.id}' order by f.path`,
        )
        .catch(() => [])
      const bundleRow = perFile.find((f) => f.path === 'cli.bundle.mjs')
      const smallRows = perFile.filter((f) => f.path.startsWith('src/'))
      const smallDone = smallRows.filter((f) => f.embedded && f.symbols === 2)
      const lateDone = smallDone.filter((f) =>
        f.path.startsWith('src/late'),
      ).length
      const batchDone = smallDone.filter((f) =>
        f.path.startsWith('src/batch'),
      ).length
      const pending = await filesPendingExtraction(ctx, repo.id)
      const pendingSql = await sqlPending(ctx, repo.id).catch(() => -1)
      const logs = await ctx.docker.app.logs('app', 400).catch(() => '')
      const notable = logs
        .split('\n')
        .filter((l) =>
          /heap|out of memory|OOM|Killed|extraction failed|catch-up|FATAL|uncaught/i.test(
            l,
          ),
        )
        .slice(0, 30)
      const restarted =
        stats.distinctStarts > 1 ||
        (stateBefore && stateAfter
          ? stateAfter.restartCount !== stateBefore.restartCount ||
            stateAfter.startedAt !== stateBefore.startedAt
          : false)

      checks.push(
        {
          name: 'app survives indexing the bundle',
          expected: 'no restart, no OOM kill, /health never down',
          actual: `restarted ${restarted} (restartCount ${stateBefore?.restartCount}->${stateAfter?.restartCount}, distinct starts ${stats.distinctStarts}), OOMKilled seen ${stats.oomKilledSeen}, kernel OOM lines ${kernelOom.length}, unhealthy samples ${stats.unhealthySamples}/${stats.samples}`,
          ok:
            !restarted && !stats.oomKilledSeen && stats.unhealthySamples === 0,
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
          name: 'files synced with the bundle still get extracted',
          expected: `${BATCH}/${BATCH} batch files embedded with 2 symbols each`,
          actual: `${batchDone}/${BATCH} (settle ${settle.outcome} in ${Math.round(settle.ms / 1000)} s)`,
          ok: batchDone === BATCH,
          severity: 'critical',
        },
        {
          name: 'files added after the bundle still get extracted',
          expected: `${LATE}/${LATE} late files embedded with 2 symbols each`,
          actual: `${lateDone}/${LATE}`,
          ok: lateDone === LATE,
          severity: 'high',
        },
        {
          name: pretty
            ? 'bundle itself: embedded with one symbol per declaration'
            : 'bundle itself: file embedding, no junk symbols',
          expected: pretty
            ? `bundle embedded, ${DECLS} symbols`
            : 'bundle embedded, 0 symbols (minified)',
          actual: bundleRow
            ? `embedded ${bundleRow.embedded}, ${bundleRow.symbols} symbols, ${bundleRow.bytes} chars`
            : 'bundle row missing',
          ok: bundleRow
            ? bundleRow.embedded && bundleRow.symbols === (pretty ? DECLS : 0)
            : null,
          severity: 'medium',
        },
        {
          name: 'filesPendingExtraction reaches 0',
          expected:
            'repository_status.filesPendingExtraction === 0 and SQL agrees',
          actual: `field ${pending.value === undefined ? `absent/failed (${pending.raw.slice(0, 120)})` : pending.value}; SQL pending ${pendingSql}`,
          ok: pending.value === 0 && pendingSql === 0,
          severity: 'medium',
        },
      )

      return {
        summary:
          `Bundle ${bundle.length} bytes, ${DECLS} declarations ${pretty ? 'one per line' : 'on one line'}, synced with ${BATCH} TS files, + ${LATE} added after. ` +
          `Settle ${settle.outcome} after ${Math.round(settle.ms / 1000)} s; peak app memory ${stats.peakMemMiB} MiB; restarted ${restarted}; ` +
          `/health down in ${stats.unhealthySamples}/${stats.samples} samples; batch files extracted ${batchDone}/${BATCH}, late ${lateDone}/${LATE}; ` +
          `bundle embedded ${bundleRow?.embedded ?? 'n/a'} with ${bundleRow?.symbols ?? 'n/a'} symbols; filesPendingExtraction ${pending.value ?? 'absent'} (SQL ${pendingSql}).`,
        checks,
        data: {
          repoId: repo.id,
          bundleBytes: bundle.length,
          variant,
          decls: DECLS,
          lateAddedAt,
          stateBefore,
          stateAfter,
          containerEvents,
          kernelOom,
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
}
