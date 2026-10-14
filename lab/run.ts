// Runs lab/tests/*.test.ts against the running lab instance.
//   bun lab/run.ts [filter...]        filters = substrings of test file names
//   LAB_TESTS="scoped,concurrency"    same, from the workflow input
// Writes lab-results/<test>.json and lab-results/summary.md. Exit code is
// non-zero only when the HARNESS failed (a test threw / timed out / none ran):
// Elara defects found by a test are results, not harness failures.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LabContext, loadEnv, type Check, type LabTest } from './lib/context.ts'
import { mcpCallLog } from './lib/mcp.ts'

const outDir = 'lab-results'
mkdirSync(outDir, { recursive: true })

const filters = [...process.argv.slice(2), ...(process.env.LAB_TESTS ?? '').split(',')]
  .map((f) => f.trim())
  .filter(Boolean)
const files = readdirSync('lab/tests')
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort()
const timeoutMs = Number(process.env.LAB_TEST_TIMEOUT_MS ?? 90 * 60_000)
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

for (const file of files) {
  const name = file.replace(/\.test\.ts$/, '')
  const ctx = new LabContext(env, name)
  const callStart = mcpCallLog.length
  const t0 = performance.now()
  console.log(`\n=== ${name} ===`)
  let row: Row
  let record: Record<string, unknown>
  try {
    // Dynamic import is the point: test files are discovered at runtime.
    const mod = (await import(join(process.cwd(), 'lab/tests', file))) as { default: LabTest }
    const test = mod.default
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
    record = { name, description: test.description, harness: 'ok', ms: Math.round(ms), ...out }
  } catch (err) {
    const ms = performance.now() - t0
    const error = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    console.error(`!!! ${name} crashed: ${error}`)
    row = { file, harness: 'crashed', ms, passed: 0, failed: 0, inconclusive: 0, summary: '', failedChecks: [], error }
    record = { name, harness: 'crashed', ms: Math.round(ms), error }
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
  `Commit ${process.env.GITHUB_SHA ?? '(local)'}; run ${process.env.GITHUB_RUN_ID ?? '-'}; ${new Date().toISOString()}`,
  '',
  '"failed" = Elara did not meet the expectation. "harness crashed" = the test itself broke.',
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

if (files.length === 0) {
  console.error(`no test matched ${JSON.stringify(filters)}`)
  process.exit(1)
}
process.exit(rows.some((r) => r.harness === 'crashed') ? 1 : 0)
