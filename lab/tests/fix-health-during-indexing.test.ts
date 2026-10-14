// Control for the bundle tests: is the server responsive while it indexes
// ordinary code? The pretty-bundle run (900 symbols in one file) saw /health
// time out for minutes with memory flat, i.e. the event loop was busy, not the
// process dead. This indexes FILES small TS files (3 symbols each) and probes
// GET /health every second (3 s timeout) until extraction completes, so the
// stall can be attributed: general embedding cost vs. one big file.
import type { Check, LabTest } from '../lib/context.ts'
import { connectLocalRepo, copyIntoLocalRepo, repoProgress, writeTree } from '../lib/fixlab.ts'

const FILES = Number(process.env.LAB_HEALTH_FILES ?? 300)

const test: LabTest = {
  name: 'fix-health-during-indexing',
  description: 'GET /health latency while a 300-file repository is extracted and embedded.',
  async run(ctx) {
    const checks: Check[] = []
    const files: Record<string, string> = {}
    for (let i = 0; i < FILES; i++) {
      files[`src/h${String(i).padStart(4, '0')}.ts`] =
        `export function one${i}(x: number): number {\n  return x + ${i}\n}\n\nexport class Two${i} {\n  run() {\n    return one${i}(1)\n  }\n}\n\nexport function three${i}() {\n  return new Two${i}().run()\n}\n`
    }
    // Warm-up: the first embedding of a fresh instance downloads/loads the model; keep that out of the probe window.
    const warmName = ctx.uniq('fix-health-warm')
    await copyIntoLocalRepo(ctx, writeTree({ 'warm.ts': 'export function warm() {\n  return 1\n}\n' }), warmName)
    const warm = await connectLocalRepo(ctx, warmName)
    const tw = Date.now()
    while ((await repoProgress(ctx, warm.id)).embedded < 1 && Date.now() - tw < 10 * 60_000) await Bun.sleep(1_000)

    const name = ctx.uniq('fix-health')
    await copyIntoLocalRepo(ctx, writeTree(files), name)
    const repo = await connectLocalRepo(ctx, name)

    const probes: Array<{ t: number; ms: number | null }> = []
    const t0 = Date.now()
    let p = await repoProgress(ctx, repo.id)
    while (!(p.files === FILES && p.embedded === FILES) && Date.now() - t0 < 20 * 60_000) {
      const s = performance.now()
      const ok = await fetch(`${ctx.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) })
        .then((r) => r.ok)
        .catch(() => false)
      probes.push({ t: Math.round((Date.now() - t0) / 1000), ms: ok ? Math.round(performance.now() - s) : null })
      p = await repoProgress(ctx, repo.id)
      // Real time on purpose: probing a live server while its queue runs.
      await Bun.sleep(1_000)
    }
    const answered = probes.map((x) => x.ms).filter((m): m is number => m !== null).sort((a, b) => a - b)
    const timeouts = probes.length - answered.length
    const p95 = answered[Math.floor(answered.length * 0.95)] ?? null

    checks.push({
      name: '/health answers while indexing ordinary code',
      expected: '0 probes time out (3 s) during extraction',
      actual: `${timeouts}/${probes.length} timed out; answered p50 ${answered[Math.floor(answered.length / 2)] ?? 'n/a'} ms, p95 ${p95 ?? 'n/a'} ms, max ${answered.at(-1) ?? 'n/a'} ms; ${p.embedded}/${p.files} embedded in ${Math.round((Date.now() - t0) / 1000)} s`,
      ok: probes.length === 0 ? null : timeouts === 0,
      severity: 'medium',
    })
    return {
      summary: `${FILES} small TS files indexed in ${Math.round((Date.now() - t0) / 1000)} s; /health timeouts ${timeouts}/${probes.length}, answered p95 ${p95} ms.`,
      checks,
      data: { repoId: repo.id, final: p, probes },
    }
  },
}
export default test
