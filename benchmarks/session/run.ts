// Session benchmark runner (#683): what per-session de-duplication saves an
// agent that re-reads, on the premise benchmark's suites and questions.
//
//   BENCH_SUITES=all bun benchmarks/session/run.ts [--session]
//
// Opt-in only (elara-lab.yml `bench_session`); the premise benchmark
// (benchmarks/run.ts) and its fingerprint are untouched: this entry lives
// outside the files its HARNESS hash covers. Same lab instance, guard,
// checkouts and indexing as benchmarks/run.ts, then the re-reading policy
// (./policy.ts) on every question of a suite, in suite order:
//   plain    without `session_id` (the only mode a server before #683 takes)
//   session  with --session, after the plain pass on the same instance: one
//            fixed `session_id` per suite on every read_file, so the session
//            spans the suite's questions. Every session answer, its
//            references expanded, is compared with the plain answer of the
//            same call (`answers` in the results): the saving is only
//            reported for equal answers.
// Writes bench-session-results/results.json and summary.md.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LabContext, loadEnv } from '../../lab/lib/context.ts'
import { exec } from '../../lab/lib/docker.ts'
import { connectLocalRepo, copyIntoLocalRepo, repoProgress, settleRepo } from '../../lab/lib/fixlab.ts'
import { assertLabBaseUrl } from '../lib/guard.ts'
import { aggregate, linePrecisionRecall, type Aggregate, type Judgments, type LineRange, type QuestionOutcome } from '../lib/metrics.ts'
import { CAPS, missCost } from '../lib/policies.ts'
import { fingerprint, judgments, parseGold, validateSuite, type Suite } from '../lib/questions.ts'
import { fileReader } from '../lib/ripgrep.ts'
import { comparable, expandAnswer, FILES, FOCUS, runReread, sessionTools, type Answer, type RereadRun } from './policy.ts'

const SEARCH_LIMIT = 10
const SESSION = process.argv.includes('--session')
const MODES = SESSION ? (['plain', 'session'] as const) : (['plain'] as const)
type Mode = (typeof MODES)[number]

/** This harness and the premise one it builds on (tests excluded), so runs of two commits show they measured alike. */
const HARNESS = createHash('sha256')
  .update(
    [
      ...readdirSync('benchmarks/session').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort().map((f) => `benchmarks/session/${f}`),
      ...readdirSync('benchmarks/lib').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort().map((f) => `benchmarks/lib/${f}`),
    ]
      .map((f) => `${f}\n${readFileSync(f, 'utf8').replaceAll('\r\n', '\n')}`)
      .join('\n'),
  )
  .digest('hex')
  .slice(0, 16)
const CONFIG = { version: 1, policy: 'reread', caps: CAPS, files: FILES, focus: FOCUS, searchLimit: SEARCH_LIMIT, harness: HARNESS }

const outDir = 'bench-session-results'
const workDir = process.env.BENCH_WORKDIR ?? join(process.env.RUNNER_TEMP ?? tmpdir(), 'elara-bench-session')
const QUESTIONS_DIR = 'benchmarks/questions'

const all = readdirSync(QUESTIONS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(QUESTIONS_DIR, f), 'utf8')) as Suite)
const wanted = (process.env.BENCH_SUITES ?? process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'all').split(',').map((s) => s.trim()).filter(Boolean)
const suites = wanted.includes('all') ? all : all.filter((s) => wanted.includes(s.suite))
const unknown = wanted.filter((w) => w !== 'all' && !all.some((s) => s.suite === w))
if (unknown.length > 0 || suites.length === 0) throw new Error(`unknown suites ${JSON.stringify(unknown)}; have ${all.map((s) => s.suite).join(', ')}`)
for (const s of suites) {
  const errors = validateSuite(s)
  if (errors.length > 0) throw new Error(`invalid suite ${s.suite}:\n${errors.join('\n')}`)
}

const env = loadEnv()
assertLabBaseUrl(env.baseUrl)
const ctx = new LabContext(env, 'bench-session', 'full')
mkdirSync(outDir, { recursive: true })

async function git(args: string[]): Promise<string> {
  const r = await exec(['git', ...args])
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.slice(0, 500)}`)
  return r.stdout.trim()
}

/** The pinned tree at workDir/<suite>, without .git (as benchmarks/run.ts). */
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

/** Every gold range must exist at the pinned commit (as benchmarks/run.ts). */
function checkGold(s: Suite, lines: (path: string) => string[], root: string): void {
  const problems: string[] = []
  for (const q of s.questions) {
    for (const g of q.gold) {
      const r = parseGold(g)
      if (!existsSync(join(root, r.path))) problems.push(`${q.id}: ${r.path} does not exist`)
      else if (r.end > lines(r.path).length) problems.push(`${q.id}: ${g} is past the end of the file`)
    }
  }
  if (problems.length > 0) throw new Error(`${s.suite} gold does not match ${s.repo.commit}:\n${problems.join('\n')}`)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const mcp = ctx.mcp('adminAccount', 'bench-session')
const call = async (tool: string, args: Record<string, unknown>) => {
  const r = await mcp.call(tool, args)
  return { text: r.text, ms: r.ms, ok: r.ok }
}

interface Row {
  tokens: number
  calls: number
  tokensToGold: number | null
  callsToGold: number | null
  trace: RereadRun['episode']['trace']
}

function outcome(gold: LineRange[], j: Judgments, run: RereadRun): { outcome: QuestionOutcome; row: Row } {
  const ep = run.episode
  const { precision, recall } = linePrecisionRecall(gold, ep.seen)
  return {
    outcome: {
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
    },
    row: { tokens: ep.tokens, calls: ep.trace.length, tokensToGold: ep.tokensToGold, callsToGold: ep.callsToGold, trace: ep.trace },
  }
}

/**
 * The session answers against the plain ones, call by call: `equal` when
 * the expanded session answer is the plain answer (search answers as sent),
 * `differ` otherwise, `unaligned` when the two passes made other calls.
 */
function compareModes(plain: Answer[][], session: Answer[][]): { calls: number; equal: number; references: number; differ: string[]; unaligned: number } {
  const sent = new Map<number, unknown>()
  const result = { calls: 0, equal: 0, references: 0, differ: [] as string[], unaligned: 0 }
  for (const [qi, answers] of session.entries()) {
    for (const [ci, answer] of answers.entries()) {
      result.calls++
      const json = answer.tool === 'read_file' ? parseJson(answer.text) : undefined
      const callNo = json && typeof json === 'object' ? Reflect.get(json, 'call') : undefined
      if (typeof callNo === 'number') sent.set(callNo, json)
      if (answer.text.includes('"same_as"')) result.references++
      const other = plain[qi]?.[ci]
      if (!other || other.tool !== answer.tool || other.args !== answer.args) {
        result.unaligned++
        continue
      }
      const same = answer.tool === 'search' ? answer.text === other.text : json !== undefined && comparable(expandAnswer(json, sent)) === comparable(parseJson(other.text))
      if (same) result.equal++
      else result.differ.push(`question ${qi + 1} call ${ci + 1} ${answer.tool} ${answer.args}`)
    }
  }
  return result
}

const t0 = Date.now()
const prepared: Array<{ s: Suite; repoId: string; index: { outcome: string; ms: number; files: number; embedded: number; symbols: number } }> = []
// One suite at a time, as benchmarks/run.ts: extraction is one global queue.
for (const s of suites) {
  ctx.log(`${s.suite}: fetching ${s.repo.url} @ ${s.repo.commit}`)
  const root = await checkout(s)
  checkGold(s, fileReader(root), root)
  const name = ctx.uniq(`bench-${s.suite}`)
  await copyIntoLocalRepo(ctx, root, name)
  const repo = await connectLocalRepo(ctx, name)
  const settled = await settleRepo(ctx, repo.id, s.suite, { stallMs: 300_000, timeoutMs: 120 * 60_000, pollMs: 5_000 })
  const last = await repoProgress(ctx, repo.id)
  prepared.push({ s, repoId: repo.id, index: { outcome: settled.outcome, ms: settled.ms, files: last.files, embedded: last.embedded, symbols: last.symbols } })
}

const miss = missCost(CAPS)
const results: Record<string, unknown> = {}
const md: string[] = [
  `# Session benchmark (${SESSION ? 'plain, then session' : 'plain'})`,
  '',
  `Commit ${process.env.GITHUB_SHA ?? '(local)'}; run ${process.env.GITHUB_RUN_ID ?? '-'}; harness ${HARNESS}; ${new Date().toISOString()}`,
  '',
  '| suite | mode | tokens total | tokens-to-gold (mean) | gold reached |',
  '|---|---|---|---|---|',
]
for (const p of prepared) {
  const { s } = p
  const byMode = {} as Record<Mode, { aggregate: Aggregate; tokensTotal: number; perQuestion: unknown[]; answers: Answer[][] }>
  for (const mode of MODES) {
    const sessionId = mode === 'session' ? ctx.uniq(`bench-${s.suite}`) : null
    const tools = sessionTools(call, p.repoId, SEARCH_LIMIT, sessionId)
    const outcomes: QuestionOutcome[] = []
    const perQuestion: unknown[] = []
    const answers: Answer[][] = []
    for (const q of s.questions) {
      const gold = q.gold.map(parseGold)
      const run = await runReread(q.question, gold, tools)
      const { outcome: o, row } = outcome(gold, judgments(q), run)
      outcomes.push(o)
      perQuestion.push({ id: q.id, ...row })
      answers.push(run.answers)
      ctx.log(`${s.suite}/${q.id} ${mode}: ${row.tokens} tok, ${row.calls} calls, to gold ${row.tokensToGold ?? 'miss'}`)
    }
    const agg = aggregate(outcomes, miss.tokens, miss.calls)
    byMode[mode] = { aggregate: agg, tokensTotal: outcomes.reduce((n, o) => n + o.tokens, 0), perQuestion, answers }
    md.push(`| ${s.suite} | ${mode} | ${byMode[mode].tokensTotal} | ${agg.tokensToGold} | ${agg.goldReached} of ${agg.questions} |`)
  }
  const answers = SESSION ? compareModes(byMode.plain.answers, byMode.session!.answers) : null
  results[s.suite] = {
    fingerprint: fingerprint(s, CONFIG),
    repo: s.repo,
    questions: s.questions.length,
    index: p.index,
    ...Object.fromEntries(MODES.map((m) => [m, { aggregate: byMode[m].aggregate, tokensTotal: byMode[m].tokensTotal, perQuestion: byMode[m].perQuestion }])),
    ...(answers ? { answers } : {}),
  }
  if (answers) ctx.log(`${s.suite}: ${answers.equal} of ${answers.calls} session answers equal the plain ones (${answers.references} with references, ${answers.unaligned} unaligned)`)
}
for (const [name, r] of Object.entries(results) as Array<[string, { answers?: { calls: number; equal: number; references: number } }]>) {
  if (r.answers) md.push('', `${name}: ${r.answers.equal} of ${r.answers.calls} session answers equal the plain ones once expanded; ${r.answers.references} carry references.`)
}

const out = {
  version: 1,
  commit: process.env.GITHUB_SHA ?? null,
  instance: process.env.BENCH_INSTANCE ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  finishedAt: new Date().toISOString(),
  ms: Date.now() - t0,
  modes: MODES,
  config: CONFIG,
  missCost: miss,
  suites: results,
}
writeFileSync(join(outDir, 'results.json'), JSON.stringify(out, null, 2))
writeFileSync(join(outDir, 'summary.md'), md.join('\n'))
console.log(md.join('\n'))
rmSync(workDir, { recursive: true, force: true })
