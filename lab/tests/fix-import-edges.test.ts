// PR #398 (fix/import-resolution-js-to-ts): TypeScript ESM imports
// (`./x.js` naming `x.ts`) and the `@/` alias must become resolved import
// edges. On dev, server/src/repositories/import-resolution.ts only tries
// `base`, `base + ext` and `base/index + ext`, so `./x.js` -> `x.js.ts`
// never matches and every ESM-style edge is dropped.
//
//   synthetic  local_path repo with known edges: 40 `./mN.js` chains,
//              10 `@/mN` alias imports, 10 extensionless `./mN` controls
//   chapters   the real PIIIX-org/chapters repo (git); server-side counts
//              of stored / resolved imports per specifier class, plus the
//              `graph` tool's extracted code edges
//   backfill   (#398 also re-resolves stored unresolved rows at boot)
//              null the synthetic repo's resolved targets in SQL, restart
//              the app, count again
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import { nextCursor } from '../lib/mcp.ts'
import {
  connectLocalRepo,
  copyIntoLocalRepo,
  filesPendingExtraction,
  settleRepo,
  sqlPending,
  writeTree,
} from '../lib/fixlab.ts'

const CHAPTERS_URL = process.env.LAB_IMPORTS_REPO_URL ?? 'https://github.com/PIIIX-org/chapters'
const N = 40

function syntheticTree(): Record<string, string> {
  const files: Record<string, string> = {}
  for (let i = 0; i < N; i++) {
    const dep = i > 0 ? `import { f${i - 1} } from './m${i - 1}.js'\n` : ''
    files[`pkg/src/m${i}.ts`] = `${dep}export function f${i}(x: number): number {\n  return ${i > 0 ? `f${i - 1}(x) + ` : ''}x\n}\n`
  }
  for (let i = 0; i < 10; i++) {
    files[`pkg/src/ui/alias${i}.ts`] = `import { f${i} } from '@/m${i}'\nexport function a${i}() {\n  return f${i}(1)\n}\n`
    files[`pkg/src/plain${i}.ts`] = `import { f${i} } from './m${i}'\nexport function p${i}() {\n  return f${i}(2)\n}\n`
  }
  return files
}

interface ImportClassRow {
  cls: string
  total: number
  resolved: number
  resolvedToTs: number
}

/** Stored imports of a repo grouped by specifier class (server-side ground truth). */
async function importClasses(ctx: LabContext, repoId: string): Promise<ImportClassRow[]> {
  return ctx.docker.psqlRows<ImportClassRow>(`
    select cls, count(*)::int as total,
      count(t.id)::int as resolved,
      count(*) filter (where t.path ~ '\\.(ts|tsx|mts|cts)$')::int as "resolvedToTs"
    from (
      select i.resolved_target_file_id,
        case
          when i.target_path like '@/%' then 'alias @/'
          when i.target_path ~ '^\\.{1,2}/.*\\.(js|jsx|mjs|cjs)$' and s.language = 'typescript' then 'relative .js-style from .ts'
          when i.target_path ~ '^\\.{1,2}/' then 'relative other'
          else 'package/bare'
        end as cls
      from repository_file_imports i join repository_files s on s.id = i.source_file_id
      where s.repository_id = '${repoId}'
    ) x left join repository_files t on t.id = x.resolved_target_file_id
    group by cls order by cls`)
}

async function unresolvedSample(ctx: LabContext, repoId: string) {
  return ctx.docker.psqlRows<{ source: string; target: string }>(`
    select s.path as source, i.target_path as target
    from repository_file_imports i join repository_files s on s.id = i.source_file_id
    where s.repository_id = '${repoId}' and i.resolved_target_file_id is null and i.target_path ~ '^(\\.{1,2}/|@/)'
    order by s.path limit 25`)
}

async function graphExtractedEdges(ctx: LabContext, repoId: string) {
  // `graph` lists nodes, then edges, page by page (#420): walk every page.
  const mcp = ctx.mcp('adminAccount')
  let r = await mcp.call('graph', { repositoryId: repoId, budget_tokens: 25_000 })
  const nodes: unknown[] = []
  const edges: Array<{ kind?: string }> = []
  for (let pages = 1; ; pages++) {
    const j = r.json as { nodes?: unknown[]; edges?: Array<{ kind?: string }> } | undefined
    nodes.push(...(j?.nodes ?? []))
    edges.push(...(j?.edges ?? []))
    const cursor = r.ok ? nextCursor(r.json) : null
    if (!cursor || pages >= 500) break
    r = await mcp.call('graph', { repositoryId: repoId, budget_tokens: 25_000, cursor })
  }
  return {
    ok: r.ok,
    nodes: r.ok ? nodes.length : null,
    extracted: edges.filter((e) => e.kind === 'extracted').length,
    byKind: edges.reduce<Record<string, number>>((acc, e) => {
      const k = String(e.kind)
      acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {}),
    error: r.ok ? undefined : r.text.slice(0, 300),
  }
}

const pick = (rows: ImportClassRow[], cls: string) => rows.find((r) => r.cls === cls) ?? { cls, total: 0, resolved: 0, resolvedToTs: 0 }

/** The real chapters repo (~7 min to index): full tier only. */
async function chaptersRepo(ctx: LabContext): Promise<{ checks: Check[]; summary: string; data: unknown }> {
  const chapters = await ctx.connectRepo('admin', ctx.uniq('fix-imports-chapters'), CHAPTERS_URL)
  const chSettle = await settleRepo(ctx, chapters.id, 'chapters', { stallMs: 120_000, timeoutMs: 40 * 60_000 })
  const chClasses = await importClasses(ctx, chapters.id)
  const chUnresolved = await unresolvedSample(ctx, chapters.id)
  const chGraph = await graphExtractedEdges(ctx, chapters.id)
  const chPending = await filesPendingExtraction(ctx, chapters.id)
  const chPendingSql = await sqlPending(ctx, chapters.id)
  const chJs = pick(chClasses, 'relative .js-style from .ts')
  const chAlias = pick(chClasses, 'alias @/')
  return {
    checks: [
      {
        name: 'chapters: .js-style relative imports in .ts files resolve',
        expected: '>= 95% resolved',
        actual: `${chJs.resolved}/${chJs.total} resolved (${chJs.total ? Math.round((100 * chJs.resolved) / chJs.total) : 0}%), settle ${chSettle.outcome}`,
        ok: chJs.total > 0 ? chJs.resolved / chJs.total >= 0.95 : null,
        severity: 'high',
      },
      {
        name: 'chapters: graph shows extracted code edges',
        expected: '> 0 extracted edges in `graph`',
        actual: chGraph.ok ? `${chGraph.extracted} extracted of ${JSON.stringify(chGraph.byKind)}, ${chGraph.nodes} nodes` : `graph failed: ${chGraph.error}`,
        ok: chGraph.ok ? chGraph.extracted > 0 : null,
        severity: 'medium',
      },
      {
        name: 'chapters: filesPendingExtraction reaches 0',
        expected: 'repository_status.filesPendingExtraction === 0 (and SQL agrees)',
        actual: `field ${chPending.value === undefined ? 'absent' : chPending.value}; SQL pending ${chPendingSql}`,
        ok: chPending.value === 0 && chPendingSql === 0,
        severity: 'medium',
      },
    ],
    summary: `Chapters (${CHAPTERS_URL}, settle ${chSettle.outcome}): .js-style ${chJs.resolved}/${chJs.total}, @/ ${chAlias.resolved}/${chAlias.total}; graph extracted edges ${chGraph.extracted}. `,
    data: {
      repoId: chapters.id,
      url: CHAPTERS_URL,
      settle: { outcome: chSettle.outcome, ms: chSettle.ms, last: chSettle.timeline.at(-1) },
      classes: chClasses,
      unresolvedSample: chUnresolved,
      graph: chGraph,
      filesPendingExtraction: chPending,
      sqlPending: chPendingSql,
    },
  }
}

const test: LabTest = {
  name: 'fix-import-edges',
  tier: 'fast',
  description: 'PR #398: .js->.ts and @/ import specifiers become resolved import edges (synthetic; chapters repo in the full tier), boot backfill.',
  async run(ctx) {
    const checks: Check[] = []

    // ---- synthetic repo with known edges
    const synthName = ctx.uniq('fix-imports')
    await copyIntoLocalRepo(ctx, writeTree(syntheticTree()), synthName)
    const synth = await connectLocalRepo(ctx, synthName)
    const synthSettle = await settleRepo(ctx, synth.id, 'synthetic', { stallMs: 60_000, timeoutMs: 15 * 60_000, minFiles: N + 20 })
    const synthClasses = await importClasses(ctx, synth.id)
    const js = pick(synthClasses, 'relative .js-style from .ts')
    const alias = pick(synthClasses, 'alias @/')
    const plain = pick(synthClasses, 'relative other')

    // ---- chapters repo (real world)
    const chapters = ctx.tier === 'full' ? await chaptersRepo(ctx) : null

    // ---- boot backfill: forget the synthetic repo's resolutions, restart
    const nulled = await ctx.docker.psql(`
      with u as (update repository_file_imports i set resolved_target_file_id = null
        from repository_files s where s.id = i.source_file_id and s.repository_id = '${synth.id}'
        and i.resolved_target_file_id is not null returning 1)
      select count(*) from u;`)
    const restart = await ctx.docker.app.restart(ctx.baseUrl)
    const afterBackfill = await importClasses(ctx, synth.id)
    const resolvedAfterBackfill = afterBackfill.reduce((n, r) => n + r.resolved, 0)
    const resolvedBefore = synthClasses.reduce((n, r) => n + r.resolved, 0)
    const bootLog = (await ctx.docker.app.logs('app', 200)).split('\n').filter((l) => /previously unresolved code import|extraction catch-up/.test(l))

    checks.push(
      {
        name: 'synthetic: ./x.js specifiers resolve to x.ts',
        expected: `${N - 1} of ${N - 1} resolved, all to .ts`,
        actual: `${js.resolved}/${js.total} resolved, ${js.resolvedToTs} to .ts (settle ${synthSettle.outcome})`,
        ok: js.total === N - 1 && js.resolved === N - 1 && js.resolvedToTs === N - 1,
        severity: 'high',
      },
      {
        name: 'synthetic: @/ alias resolves to <pkg>/src',
        expected: '10 of 10 resolved',
        actual: `${alias.resolved}/${alias.total} resolved`,
        ok: alias.total === 10 && alias.resolved === 10,
        severity: 'medium',
      },
      {
        name: 'synthetic control: extensionless ./x still resolves',
        expected: '10 of 10 resolved',
        actual: `${plain.resolved}/${plain.total} resolved`,
        ok: plain.total === 10 && plain.resolved === 10,
        severity: 'high',
      },
      ...(chapters?.checks ?? []),
      {
        name: 'boot backfill re-resolves stored unresolved imports',
        expected: `after nulling ${nulled} rows and restarting: ${resolvedBefore} resolved again`,
        actual: `${resolvedAfterBackfill} resolved after restart (healthy in ${Math.round(restart.healthyMs)} ms)`,
        ok: Number(nulled) > 0 ? resolvedAfterBackfill === resolvedBefore : null,
        severity: 'medium',
      },
    )

    return {
      summary:
        `Synthetic: .js-style ${js.resolved}/${js.total}, @/ ${alias.resolved}/${alias.total}, extensionless ${plain.resolved}/${plain.total} resolved. ` +
        (chapters?.summary ?? 'Chapters repo skipped (fast tier). ') +
        `Backfill: ${nulled} nulled -> ${resolvedAfterBackfill} resolved after restart.`,
      checks,
      data: {
        synthetic: { repoId: synth.id, settle: { outcome: synthSettle.outcome, ms: synthSettle.ms, last: synthSettle.timeline.at(-1) }, classes: synthClasses },
        chapters: chapters?.data ?? null,
        backfill: { nulled: Number(nulled), restart, resolvedBefore, resolvedAfterBackfill, classes: afterBackfill, bootLog },
      },
    }
  },
}
export default test
