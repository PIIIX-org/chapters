// Runs lab/tests/*.test.ts against the running lab instance.
//   bun lab/run.ts [filter...]        filters = substrings of test file names
//   LAB_TESTS="scoped,concurrency"    same, from the workflow input
//   LAB_TIER=fast|full                without filters: fast = tests that
//                                     declare `tier: 'fast'`, full = all;
//                                     tests also read it (ctx.tier) to skip
//                                     their long parts in the fast tier
// Writes lab-results/<test>.json, lab-results/summary.md and
// lab-results/run.json (tier + selected tests, read by the gate). Exit code
// is non-zero only when nothing ran: whether the run passes is decided by
// .github/scripts/lab-gate.mjs against lab/known-defects.json (a check that
// failed and is not a known defect, a known defect that passed, or a test
// that threw / timed out).
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LabContext, loadEnv, type Check, type LabTest, type Tier } from './lib/context.ts'
import { mcpCallLog } from './lib/mcp.ts'

const outDir = 'lab-results'
mkdirSync(outDir, { recursive: true })

const tierEnv = process.env.LAB_TIER || 'full'
if (tierEnv !== 'fast' && tierEnv !== 'full') throw new Error(`LAB_TIER must be fast or full, got ${tierEnv}`)
const tier: Tier = tierEnv
const filters = [...process.argv.slice(2), ...(process.env.LAB_TESTS ?? '').split(',')]
  .map((f) => f.trim())
  .filter(Boolean)
const timeoutMs = Number(process.env.LAB_TEST_TIMEOUT_MS ?? 90 * 60_000)

/** A test module, or the error that stopped it from loading (reported as a crash). */
type Loaded = { file: string; name: string; test?: LabTest; loadError?: string }

function describeError(err: unknown) {
  return err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
}

async function load(file: string): Promise<Loaded> {
  const name = file.replace(/\.test\.ts$/, '')
  try {
    // Dynamic import is the point: test files are discovered at runtime.
    const mod = (await import(join(process.cwd(), 'lab/tests', file))) as { default: LabTest }
    return { file, name, test: mod.default }
  } catch (err) {
    return { file, name, loadError: describeError(err) }
  }
}

const all = await Promise.all(
  readdirSync('lab/tests')
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map(load),
)
// A test that fails to load is selected in every tier, so a broken full-tier
// test still turns the fast tier red.
const selected = all.filter((t) =>
  filters.length > 0 ? filters.some((x) => t.file.includes(x)) : tier === 'full' || !t.test || t.test.tier === 'fast',
)

if (selected.length === 0) {
  console.error(`no test matched ${JSON.stringify(filters)} (tier ${tier})`)
  process.exit(1)
}
writeFileSync(
  join(outDir, 'run.json'),
  JSON.stringify({ tier, filters, tests: selected.map((t) => t.name), commit: process.env.GITHUB_SHA ?? null }, null, 2),
)

const env = loadEnv()

interface Row {
  file: string
  harness: 'ok' | 'crashed'
  ms: number
  passed: number
  failed: number
  inconclusive: number
  summary: string
  failedChecks: Check[]
  error?: string
}
const rows: Row[] = []

for (const { file, name, test, loadError } of selected) {
  const ctx = new LabContext(env, name, tier)
  const callStart = mcpCallLog.length
  const t0 = performance.now()
  console.log(`\n=== ${name} (${tier}) ===`)
  let row: Row
  let record: Record<string, unknown>
  try {
    if (!test) throw new Error(`failed to load: ${loadError}`)
    let timer: Timer | undefined
    const out = await Promise.race([
      test.run(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
      }),
    ]).finally(() => clearTimeout(timer))
    const ms = performance.now() - t0
    const failedChecks = out.checks.filter((c) => c.ok === false)
    row = {
      file,
      harness: 'ok',
      ms,
      passed: out.checks.filter((c) => c.ok === true).length,
      failed: failedChecks.length,
      inconclusive: out.checks.filter((c) => c.ok === null).length,
      summary: out.summary,
      failedChecks,
    }
    record = { name, description: test.description, tier, harness: 'ok', ms: Math.round(ms), ...out }
  } catch (err) {
    const ms = performance.now() - t0
    const error = describeError(err)
    console.error(`!!! ${name} crashed: ${error}`)
    row = { file, harness: 'crashed', ms, passed: 0, failed: 0, inconclusive: 0, summary: '', failedChecks: [], error }
    record = { name, tier, harness: 'crashed', ms: Math.round(ms), error }
  }
  const calls = mcpCallLog.slice(callStart)
  const sorted = calls.map((c) => c.ms).sort((a, b) => a - b)
  record.mcpCalls = {
    count: calls.length,
    errors: calls.filter((c) => c.isError).length,
    http429Retries: calls.reduce((n, c) => n + c.retries429, 0),
    p50ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    maxMs: sorted.at(-1) ?? null,
    totalChars: calls.reduce((n, c) => n + c.chars, 0),
    byTool: Object.fromEntries(
      [...new Set(calls.map((c) => c.tool))].map((t) => [t, calls.filter((c) => c.tool === t).length]),
    ),
  }
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(record, null, 2))
  rows.push(row)
  console.log(`=== ${name}: harness ${row.harness}, ${row.passed} ok / ${row.failed} failed / ${row.inconclusive} inconclusive, ${Math.round(row.ms / 1000)} s`)
}

const md: string[] = [
  '# Elara lab results',
  '',
  `Tier ${tier}${filters.length ? `, tests ${filters.join(',')}` : ''}; commit ${process.env.GITHUB_SHA ?? '(local)'}; run ${process.env.GITHUB_RUN_ID ?? '-'}; ${new Date().toISOString()}`,
  '',
  '"failed" = Elara did not meet the expectation (the gate compares these with lab/known-defects.json). "harness crashed" = the test itself broke.',
  '',
  '| test | harness | ok | failed | inconclusive | time |',
  '|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.file} | ${r.harness} | ${r.passed} | ${r.failed} | ${r.inconclusive} | ${Math.round(r.ms / 1000)} s |`,
  ),
  '',
]
for (const r of rows) {
  md.push(`## ${r.file}`, '', r.harness === 'crashed' ? '```\n' + r.error + '\n```' : r.summary, '')
  if (r.failedChecks.length > 0) {
    md.push('| failed check | severity | expected | actual |', '|---|---|---|---|')
    for (const c of r.failedChecks) {
      const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)
      md.push(`| ${cell(c.name)} | ${c.severity ?? ''} | ${cell(c.expected)} | ${cell(c.actual)} |`)
    }
    md.push('')
  }
}
writeFileSync(join(outDir, 'summary.md'), md.join('\n'))
console.log(md.join('\n'))
