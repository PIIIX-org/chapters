// Premise benchmark runner (#570): how many tokens and calls an agent needs
// to reach the evidence for a question, Elara (MCP search + read_file)
// versus ripgrep + ranged reads over a checkout of the same commit.
//
//   BENCH_SUITES=chapters bun benchmarks/run.ts      (comma list, or "all")
//
// Runs on the lab runner after lab/bootstrap.ts (reads lab-env.json) against
// the instance built from the commit under test, and refuses any other base
// URL. For each suite (benchmarks/questions/<suite>.json) it fetches the
// repository at the pinned commit, copies the tree into the app container
// and connects it as a local_path repository (a git connection follows the
// upstream head), waits until every file is embedded, then runs both
// policies (benchmarks/lib/policies.ts) on every question. Writes
// bench-results/results.json and summary.md; the verdict against
// benchmarks/baseline.json is .github/scripts/bench-gate.mjs.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LabContext, loadEnv } from '../lab/lib/context.ts'
import { exec } from '../lab/lib/docker.ts'
import { connectLocalRepo, copyIntoLocalRepo, repoProgress, settleRepo } from '../lab/lib/fixlab.ts'
import { assertLabBaseUrl } from './lib/guard.ts'
import { aggregate, linePrecisionRecall, pairedTokensToGold, type Aggregate, type QuestionOutcome } from './lib/metrics.ts'
import { CAPS, GREP, missCost, runElara, runGrep, type ElaraTools, type PolicyRun } from './lib/policies.ts'
import { fingerprint, judgments, parseGold, validateSuite, type Question, type Suite } from './lib/questions.ts'
import { fileReader, grepTools } from './lib/ripgrep.ts'

const SEARCH_LIMIT = 10
/**
 * The harness source that turns tool output into numbers (this runner and
 * benchmarks/lib, tests excluded), hashed with line endings normalised. Part
 * of every suite's fingerprint, so a PR that changes how anything is
 * measured cannot be judged by a baseline measured the old way.
 */
const HARNESS = createHash('sha256')
  .update(
    ['benchmarks/run.ts', ...readdirSync('benchmarks/lib').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort().map((f) => `benchmarks/lib/${f}`)]
      .map((f) => `${f}\n${readFileSync(f, 'utf8').replaceAll('\r\n', '\n')}`)
      .join('\n'),
  )
  .digest('hex')
  .slice(0, 16)
/** Everything that changes what a number means; part of each suite's fingerprint. */
const CONFIG = { version: 1, caps: CAPS, grep: GREP, searchLimit: SEARCH_LIMIT, harness: HARNESS }

const outDir = 'bench-results'
const workDir = process.env.BENCH_WORKDIR ?? join(process.env.RUNNER_TEMP ?? tmpdir(), 'elara-bench')
const QUESTIONS_DIR = 'benchmarks/questions'

const all = readdirSync(QUESTIONS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(QUESTIONS_DIR, f), 'utf8')) as Suite)
const wanted = (process.env.BENCH_SUITES ?? process.argv[2] ?? 'chapters').split(',').map((s) => s.trim()).filter(Boolean)
const suites = wanted.includes('all') ? all : all.filter((s) => wanted.includes(s.suite))
const unknown = wanted.filter((w) => w !== 'all' && !all.some((s) => s.suite === w))
if (unknown.length > 0 || suites.length === 0) throw new Error(`unknown suites ${JSON.stringify(unknown)}; have ${all.map((s) => s.suite).join(', ')}`)
for (const s of suites) {
  const errors = validateSuite(s)
  if (errors.length > 0) throw new Error(`invalid suite ${s.suite}:\n${errors.join('\n')}`)
}

const env = loadEnv()
assertLabBaseUrl(env.baseUrl)
const ctx = new LabContext(env, 'bench', 'full')
mkdirSync(outDir, { recursive: true })

async function git(args: string[]): Promise<string> {
  const r = await exec(['git', ...args])
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.slice(0, 500)}`)
  return r.stdout.trim()
}

/** The pinned tree at workDir/<suite>, without .git (both policies see exactly these files). */
async function checkout(s: Suite): Promise<string> {
  const dir = join(workDir, s.suite)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  await git(['-C', dir, 'init', '-q'])
  await git(['-C', dir, 'fetch', '-q', '--depth', '1', s.repo.url, s.repo.commit])
  await git(['-C', dir, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'])
  const head = await git(['-C', dir, 'rev-parse', 'HEAD'])
  if (head !== s.repo.commit) throw new Error(`${s.suite}: checked out ${head}, expected ${s.repo.commit}`)
  rmSync(join(dir, '.git'), { recursive: true, force: true })
  return dir
}

/** Every gold range must exist at the pinned commit, or the question is wrong. */
function checkGold(s: Suite, lines: (path: string) => string[], root: string): void {
  const problems: string[] = []
  for (const q of s.questions) {
    for (const path of q.relevant) if (!existsSync(join(root, path))) problems.push(`${q.id}: ${path} does not exist`)
    for (const g of q.gold) {
      const r = parseGold(g)
      if (!existsSync(join(root, r.path))) continue
      const n = lines(r.path).length
      if (r.end > n) problems.push(`${q.id}: ${g} is past the end of the file (${n} lines)`)
    }
  }
  if (problems.length > 0) throw new Error(`${s.suite} gold does not match ${s.repo.commit}:\n${problems.join('\n')}`)
}

function elaraTools(repositoryId: string): ElaraTools {
  const mcp = ctx.mcp('adminAccount', 'bench')
  return {
    async search(query) {
      const r = await mcp.call('search', { query, repositoryId, limit: SEARCH_LIMIT })
      return { text: r.text, ms: r.ms, ok: r.ok }
    },
    async readFile(path) {
      const r = await mcp.call('read_file', { repositoryId, path })
      return { text: r.text, ms: r.ms, ok: r.ok }
    },
  }
}

interface PolicyRow {
  rank: number | null
  ranking: string[]
  tokensToGold: number | null
  callsToGold: number | null
  tokensToAllGold: number | null
  precision: number
  recall: number
  tokens: number
  calls: number
  ms: number
  trace: PolicyRun['episode']['trace']
}

function outcome(q: Question, run: PolicyRun): { outcome: QuestionOutcome; row: PolicyRow } {
  const gold = q.gold.map(parseGold)
  const ep = run.episode
  const { precision, recall } = linePrecisionRecall(gold, ep.seen)
  const j = judgments(q)
  const rankIndex = run.ranking.findIndex((p) => j.has(p))
  const o: QuestionOutcome = {
    ranking: run.ranking,
    judgments: j,
    tokensToGold: ep.tokensToGold,
    callsToGold: ep.callsToGold,
    tokensToAllGold: ep.tokensToAllGold,
    precision,
    recall,
    tokens: ep.tokens,
    calls: ep.trace.length,
    ms: ep.ms,
  }
  const row: PolicyRow = {
    rank: rankIndex < 0 ? null : rankIndex + 1,
    ranking: run.ranking.slice(0, 10),
    tokensToGold: o.tokensToGold,
    callsToGold: o.callsToGold,
    tokensToAllGold: o.tokensToAllGold,
    precision: Math.round(precision * 10_000) / 10_000,
    recall: Math.round(recall * 10_000) / 10_000,
    tokens: o.tokens,
    calls: o.calls,
    ms: Math.round(o.ms),
    trace: ep.trace,
  }
  return { outcome: o, row }
}

const t0 = Date.now()
interface Index {
  outcome: 'complete' | 'stalled' | 'timeout'
  ms: number
  files: number
  embedded: number
  symbols: number
  lastSyncError: string | null
}
const prepared: Array<{ s: Suite; root: string; lines: (path: string) => string[]; repoId: string; index: Index }> = []
// One suite at a time: extraction is one global FIFO queue, so a repository
// connected while another is indexing shows no progress until the first is
// done, and would look stalled. The questions only start once every suite is
// indexed, so indexing never competes with the measured calls.
for (const s of suites) {
  ctx.log(`${s.suite}: fetching ${s.repo.url} @ ${s.repo.commit}`)
  const root = await checkout(s)
  const lines = fileReader(root)
  checkGold(s, lines, root)
  const name = ctx.uniq(`bench-${s.suite}`)
  await copyIntoLocalRepo(ctx, root, name)
  const repo = await connectLocalRepo(ctx, name)
  ctx.log(`${s.suite}: connected as local_path ${name} (${repo.id})`)
  const settled = await settleRepo(ctx, repo.id, s.suite, { stallMs: 300_000, timeoutMs: 120 * 60_000, pollMs: 5_000 })
  const last = await repoProgress(ctx, repo.id)
  const index: Index = { outcome: settled.outcome, ms: settled.ms, files: last.files, embedded: last.embedded, symbols: last.symbols, lastSyncError: last.lastSyncError }
  prepared.push({ s, root, lines, repoId: repo.id, index })
}

const miss = missCost(CAPS)
const results: Record<string, unknown> = {}
const md: string[] = [
  '# Premise benchmark',
  '',
  `Commit ${process.env.GITHUB_SHA ?? '(local)'}; run ${process.env.GITHUB_RUN_ID ?? '-'}; suites ${suites.map((s) => s.suite).join(', ')}; ${new Date().toISOString()}`,
  '',
]
for (const p of prepared) {
  const { s, index } = p
  const tools = { elara: elaraTools(p.repoId), grep: grepTools(p.root, p.lines) }
  const perQuestion = []
  const outcomes: { elara: QuestionOutcome[]; grep: QuestionOutcome[] } = { elara: [], grep: [] }
  for (const q of s.questions) {
    const gold = q.gold.map(parseGold)
    const grep = outcome(q, await runGrep(q.keywords, gold, tools.grep))
    const elara = outcome(q, await runElara(q.question, gold, tools.elara))
    outcomes.grep.push(grep.outcome)
    outcomes.elara.push(elara.outcome)
    perQuestion.push({ id: q.id, category: q.category, elara: elara.row, grep: grep.row })
    ctx.log(`${s.suite}/${q.id}: elara rank ${elara.row.rank ?? '-'} ${elara.row.tokensToGold ?? 'miss'} tok | grep rank ${grep.row.rank ?? '-'} ${grep.row.tokensToGold ?? 'miss'} tok`)
  }
  const agg: Record<'elara' | 'grep', Aggregate> = {
    elara: aggregate(outcomes.elara, miss.tokens, miss.calls),
    grep: aggregate(outcomes.grep, miss.tokens, miss.calls),
  }
  results[s.suite] = {
    fingerprint: fingerprint(s, CONFIG),
    repo: s.repo,
    questions: s.questions.length,
    index,
    aggregate: agg,
    paired: pairedTokensToGold(outcomes.elara, outcomes.grep),
    perQuestion,
  }
  md.push(
    `## ${s.suite} (${s.questions.length} questions, ${s.repo.url} @ ${s.repo.commit.slice(0, 7)})`,
    '',
    `Index: ${index.outcome}, ${index.files} files, ${index.symbols} symbols, ${Math.round(index.ms / 1000)} s.`,
    '',
    '| metric | elara | grep |',
    '|---|---|---|',
    ...(Object.keys(agg.elara) as Array<keyof Aggregate>).map((k) => `| ${k} | ${agg.elara[k]} | ${agg.grep[k]} |`),
    '',
  )
}

const out = {
  version: 1,
  commit: process.env.GITHUB_SHA ?? null,
  instance: process.env.BENCH_INSTANCE ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  runUrl: process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
  finishedAt: new Date().toISOString(),
  ms: Date.now() - t0,
  selected: suites.map((s) => s.suite),
  config: CONFIG,
  missCost: miss,
  suites: results,
}
writeFileSync(join(outDir, 'results.json'), JSON.stringify(out, null, 2))
writeFileSync(join(outDir, 'summary.md'), md.join('\n'))
console.log(md.join('\n'))
// The checkouts can be large (rea); the runner is discarded, but keep local runs tidy.
rmSync(workDir, { recursive: true, force: true })
