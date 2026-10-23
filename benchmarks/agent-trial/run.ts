// Agent trial runner (#571): real AI agents on the study's 8 A/B tasks, one
// arm with only Elara's MCP tools against the lab instance, one with only
// read/grep on a checkout of the same commit, through the same capped loop
// (lib/loop.ts). Graded deterministically (lib/grade.ts).
//
//   bun benchmarks/agent-trial/run.ts
//   AGENT_TRIAL_MODE=scripted bun benchmarks/agent-trial/run.ts   (dry run)
//
// Model selection and the no-credential skip: lib/config.ts. Without an
// agent credential (and not scripted) it prints the skip notice and exits 0
// before touching the lab. Otherwise it runs on the lab runner after
// lab/bootstrap.ts (reads lab-env.json), refuses any base URL that is not the
// lab instance on this machine, fetches the pinned commit, checks every
// evidence range, indexes the tree as a local_path repository, mints a
// repository-pinned read token limited to the Elara arm's tools, and runs
// each selected task in each selected arm. Writes agent-trial-results/
// results.json and summary.md. Docs: benchmarks/README.md.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LabContext, loadEnv } from '../../lab/lib/context.ts'
import { exec } from '../../lab/lib/docker.ts'
import { connectLocalRepo, copyIntoLocalRepo, repoProgress, settleRepo } from '../../lab/lib/fixlab.ts'
import { assertLabBaseUrl } from '../lib/guard.ts'
import { dryRunAnswer, dryRunPlan, parseArms, systemPrompt, type Arm } from './lib/arms.ts'
import { resolveMode } from './lib/config.ts'
import { gradeAnswer, type Grade } from './lib/grade.ts'
import { judgeAnswer, type JudgeResult } from './lib/judge.ts'
import { DEFAULT_CAPS, runEpisode, type Caps, type EpisodeResult } from './lib/loop.ts'
import { httpModel, scriptedModel, type Model } from './lib/model.ts'
import { checkEvidence, selectTasks, validateTasks, type TaskFile } from './lib/tasks.ts'
import { ELARA_TOOLS, elaraToolset, localToolset, type Toolset } from './lib/tools.ts'

const DIR = 'benchmarks/agent-trial'
const outDir = 'agent-trial-results'
const workDir = process.env.AGENT_TRIAL_WORKDIR ?? join(process.env.RUNNER_TEMP ?? tmpdir(), 'elara-agent-trial')

const mode = resolveMode(process.env)
mkdirSync(outDir, { recursive: true })
if (mode.mode === 'skip') {
  console.log(mode.reason)
  writeFileSync(join(outDir, 'summary.md'), `# Agent trial\n\n${mode.reason}\n`)
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ version: 1, skipped: true, reason: mode.reason }, null, 2))
  process.exit(0)
}

/** Everything that turns model output into numbers, hashed with line endings normalised. */
const HARNESS = createHash('sha256')
  .update(
    [`${DIR}/run.ts`, `${DIR}/tasks.json`, ...readdirSync(`${DIR}/lib`).filter((f) => /\.(ts|mjs)$/.test(f) && !f.endsWith('.test.ts')).sort().map((f) => `${DIR}/lib/${f}`)]
      .map((f) => `${f}\n${readFileSync(f, 'utf8').replaceAll('\r\n', '\n')}`)
      .join('\n'),
  )
  .digest('hex')
  .slice(0, 16)

const file = JSON.parse(readFileSync(`${DIR}/tasks.json`, 'utf8')) as TaskFile
const invalid = validateTasks(file)
if (invalid.length > 0) throw new Error(`invalid ${DIR}/tasks.json:\n${invalid.join('\n')}`)
const tasks = selectTasks(file, process.env.AGENT_TRIAL_TASKS ?? '')
const arms = parseArms(process.env.AGENT_TRIAL_ARMS ?? '')
const caps: Caps = {
  ...DEFAULT_CAPS,
  ...(process.env.AGENT_TRIAL_MAX_TOOL_CALLS ? { maxToolCalls: Number(process.env.AGENT_TRIAL_MAX_TOOL_CALLS) } : {}),
  ...(process.env.AGENT_TRIAL_MAX_TOKENS ? { maxTokens: Number(process.env.AGENT_TRIAL_MAX_TOKENS) } : {}),
}
if (!Number.isInteger(caps.maxToolCalls) || caps.maxToolCalls < 1 || !Number.isInteger(caps.maxTokens) || caps.maxTokens < 1) {
  throw new Error(`invalid caps ${JSON.stringify(caps)}`)
}

const env = loadEnv()
assertLabBaseUrl(env.baseUrl)
const ctx = new LabContext(env, 'agent-trial', 'full')
const t0 = Date.now()

async function git(args: string[]): Promise<string> {
  const r = await exec(['git', ...args])
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.slice(0, 500)}`)
  return r.stdout.trim()
}

// The pinned tree without .git: the local arm reads exactly what Elara indexes.
const root = join(workDir, 'chapters')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
ctx.log(`fetching ${file.repo.url} @ ${file.repo.commit}`)
await git(['-C', root, 'init', '-q'])
await git(['-C', root, 'fetch', '-q', '--depth', '1', file.repo.url, file.repo.commit])
await git(['-C', root, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'])
const head = await git(['-C', root, 'rev-parse', 'HEAD'])
if (head !== file.repo.commit) throw new Error(`checked out ${head}, expected ${file.repo.commit}`)
rmSync(join(root, '.git'), { recursive: true, force: true })
const evidence = checkEvidence(file, (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8').split('\n') : null))
if (evidence.length > 0) throw new Error(`${DIR}/tasks.json does not match ${file.repo.commit}:\n${evidence.join('\n')}`)

const repoName = ctx.uniq('agent-trial-chapters')
await copyIntoLocalRepo(ctx, root, repoName)
const repo = await connectLocalRepo(ctx, repoName)
ctx.log(`connected as local_path ${repoName} (${repo.id}); waiting for indexing`)
const settled = await settleRepo(ctx, repo.id, 'agent-trial', { stallMs: 300_000, timeoutMs: 120 * 60_000, pollMs: 5_000 })
const progress = await repoProgress(ctx, repo.id)
const index = { outcome: settled.outcome, ms: settled.ms, files: progress.files, embedded: progress.embedded, symbols: progress.symbols, lastSyncError: progress.lastSyncError }
ctx.log(`index ${index.outcome}: ${index.files} files, ${index.embedded} embedded, ${index.symbols} symbols`)
if (index.outcome !== 'complete') throw new Error(`indexing did not complete (${index.outcome}); not running agents on a partial index`)

// The Elara arm's token: pinned to the trial repository, read access, only its tools. The
// `admin` profile (#428), because `repository_status`, its first call, is in no smaller profile;
// the allow-list is what limits it to ELARA_TOOLS.
const minted = await ctx.mintToken('admin', ctx.uniq('agent-trial'), 'repository', { repositoryId: repo.id, access: 'read', profile: 'admin', allowedTools: ELARA_TOOLS })
const mcp = ctx.mcp(minted.token, 'agent-trial')
const toolsets: Record<Arm, Toolset> = {
  elara: elaraToolset(await mcp.listTools(), async (tool, args, timeoutMs) => {
    const r = await mcp.call(tool, args, timeoutMs)
    return { text: r.text, ok: r.ok }
  }),
  local: localToolset(root),
}

const secrets = [minted.token, ...(mode.mode === 'live' ? [mode.apiKey] : [])]
const redact = (text: string) => secrets.reduce((t, s) => t.split(s).join('***'), text)
const live = mode.mode === 'live' ? httpModel({ provider: mode.provider, model: mode.model, apiKey: mode.apiKey, ...(mode.baseUrl ? { baseUrl: mode.baseUrl } : {}) }) : null
const judging = live !== null && mode.mode === 'live' && mode.judge

/**
 * Episodes start only while one more (and its judge call) fits in the run's
 * budget, so the job never hits its timeout mid-episode. The workflow's
 * 350-minute job timeout leaves room for the lab build before this script
 * and the log collection after it.
 */
const RUN_BUDGET_MS = Number(process.env.AGENT_TRIAL_RUN_BUDGET_MIN ?? 300) * 60_000
const JUDGE_TIMEOUT_MS = 3 * 60_000
if (!Number.isFinite(RUN_BUDGET_MS) || RUN_BUDGET_MS <= 0) throw new Error(`invalid AGENT_TRIAL_RUN_BUDGET_MIN ${process.env.AGENT_TRIAL_RUN_BUDGET_MIN}`)

interface Row {
  task: string
  arm: Arm
  episode: EpisodeResult
  grade: Grade
  judge?: JudgeResult
}
const rows: Row[] = []
const notRun: Array<{ task: string; arm: Arm; reason: string }> = []

function totals(arm: Arm) {
  const mine = rows.filter((r) => r.arm === arm)
  const sum = (f: (r: Row) => number) => mine.reduce((s, r) => s + f(r), 0)
  const found = sum((r) => r.grade.found)
  const total = sum((r) => r.grade.total)
  const stops: Record<string, number> = {}
  for (const r of mine) stops[r.episode.stop] = (stops[r.episode.stop] ?? 0) + 1
  return {
    tasks: mine.length,
    factsFound: found,
    factsTotal: total,
    recall: total === 0 ? 0 : Math.round((found / total) * 10_000) / 10_000,
    falseClaims: sum((r) => r.grade.falseClaims.length),
    tokensIn: sum((r) => r.episode.tokensIn),
    tokensOut: sum((r) => r.episode.tokensOut),
    judgeTokensIn: sum((r) => r.judge?.usage.input ?? 0),
    judgeTokensOut: sum((r) => r.judge?.usage.output ?? 0),
    toolCalls: sum((r) => r.episode.toolCalls),
    wallMs: sum((r) => r.episode.wallMs),
    stops,
  }
}

const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null
const dryRun = mode.mode === 'scripted'
const modelInfo = live ? { provider: live.provider, name: live.name, judge: judging } : { provider: 'scripted', name: 'scripted', judge: false }

/** Writes results.json and summary.md as they stand; called after every episode, so a cut-off run keeps what it measured. */
function flush(complete: boolean): string {
  const at = new Date().toISOString()
  const totalsByArm = Object.fromEntries(arms.map((a) => [a, totals(a)]))
  const out = {
    version: 1,
    complete,
    dryRun,
    model: modelInfo,
    commit: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runUrl,
    updatedAt: at,
    ms: Date.now() - t0,
    harness: HARNESS,
    repo: file.repo,
    caps,
    runBudgetMs: RUN_BUDGET_MS,
    index,
    elaraTools: ELARA_TOOLS,
    totals: totalsByArm,
    notRun,
    tasks: rows.map((r) => ({
      task: r.task,
      arm: r.arm,
      ...r.episode,
      grade: {
        found: r.grade.found,
        total: r.grade.total,
        recall: r.grade.recall,
        foundFacts: r.grade.facts.filter((f) => f.found).map((f) => f.id),
        missingFacts: r.grade.facts.filter((f) => !f.found).map((f) => f.id),
        falseClaims: r.grade.falseClaims,
      },
      ...(r.judge ? { judge: r.judge } : {}),
    })),
  }
  const judged = rows.some((r) => r.judge)
  const md: string[] = [
    '# Agent trial',
    '',
    ...(dryRun ? ['**DRY RUN**: scripted model (a fixed tool-call script, no language model). These numbers test the plumbing; they are not agent numbers.', ''] : []),
    ...(complete ? [] : [`**INCOMPLETE**: ${rows.length} of ${tasks.length * arms.length} episodes run${notRun.length > 0 ? `, ${notRun.length} not run (run budget)` : ' so far'}.`, '']),
    `Model ${modelInfo.provider}/${modelInfo.name}; Elara at ${process.env.GITHUB_SHA ?? '(local)'}; run ${runUrl ?? '-'}; tasks on ${file.repo.url} @ ${file.repo.commit.slice(0, 7)}; harness ${HARNESS}; ${at}`,
    '',
    `Index: ${index.outcome}, ${index.files} files, ${index.symbols} symbols, ${Math.round(index.ms / 1000)} s. Caps per task: ${caps.maxToolCalls} tool calls, ${caps.maxTokens} tokens (judge included), ${Math.round(caps.maxWallMs / 60_000)} min.`,
    '',
    `| task | arm | facts | false claims | tokens in | tokens out | tool calls | wall s | stop |${judged ? ' judge facts |' : ''}`,
    `|---|---|---|---|---|---|---|---|---|${judged ? '---|' : ''}`,
    ...rows.map((r) => {
      const j = r.judge ? (r.judge.error ? ' error |' : ` ${r.judge.found}/${r.grade.total} |`) : judged ? ' - |' : ''
      return `| ${r.task} | ${r.arm} | ${r.grade.found}/${r.grade.total} | ${r.grade.falseClaims.map((c) => c.id).join(', ') || 0} | ${r.episode.tokensIn} | ${r.episode.tokensOut} | ${r.episode.toolCalls} | ${Math.round(r.episode.wallMs / 1000)} | ${r.episode.stop} |${j}`
    }),
    ...notRun.map((n) => `| ${n.task} | ${n.arm} | not run: ${n.reason} | | | | | | |${judged ? ' |' : ''}`),
    '',
    '| arm | facts found | recall | false claims | tokens in | tokens out | tool calls | wall s |',
    '|---|---|---|---|---|---|---|---|',
    ...arms.map((a) => {
      const t = totalsByArm[a]!
      return `| ${a} | ${t.factsFound}/${t.factsTotal} | ${t.recall} | ${t.falseClaims} | ${t.tokensIn} | ${t.tokensOut} | ${t.toolCalls} | ${Math.round(t.wallMs / 1000)} |`
    }),
    '',
    dryRun
      ? 'Token counts are characters / 4 estimates (scripted model).'
      : rows.some((r) => r.episode.tokensEstimated)
        ? `Token counts of ${rows.filter((r) => r.episode.tokensEstimated).map((r) => `${r.task}/${r.arm}`).join(', ')} include characters / 4 estimates: the provider reported no usage for some turns. The rest are as reported by the provider.`
        : 'Token counts are as reported by the provider; judge tokens are in results.json (`judgeTokensIn/Out`).',
    '',
    'Only numbers from this workflow may be published (benchmarks/README.md, "Agent trial").',
  ]
  const summary = redact(md.join('\n'))
  writeFileSync(join(outDir, 'results.json'), redact(JSON.stringify(out, null, 2)))
  writeFileSync(join(outDir, 'summary.md'), summary)
  return summary
}

for (const task of tasks) {
  for (const arm of arms) {
    const needMs = caps.maxWallMs + (judging ? JUDGE_TIMEOUT_MS : 0)
    if (Date.now() - t0 + needMs > RUN_BUDGET_MS) {
      notRun.push({ task: task.id, arm, reason: `run budget (${Math.round(RUN_BUDGET_MS / 60_000)} min) would be exceeded` })
      flush(false)
      continue
    }
    const model: Model = live ?? scriptedModel(dryRunPlan(task, arm), dryRunAnswer)
    const episode = await runEpisode({ model, tools: toolsets[arm], system: systemPrompt(arm, { maxToolCalls: caps.maxToolCalls, repositoryId: repo.id }), prompt: task.prompt, caps })
    const grade = gradeAnswer(task, episode.answer)
    const row: Row = { task: task.id, arm, episode, grade }
    if (live && judging && episode.answer) {
      const tokensLeft = caps.maxTokens - episode.tokensIn - episode.tokensOut
      row.judge = await judgeAnswer(live, task, episode.answer, { tokensLeft, timeoutMs: JUDGE_TIMEOUT_MS }).catch((err: unknown) => ({
        facts: {},
        found: 0,
        usage: { input: 0, output: 0 },
        error: err instanceof Error ? err.message : String(err),
      }))
    }
    rows.push(row)
    flush(false)
    ctx.log(
      `${task.id}/${arm}: ${episode.stop}, facts ${grade.found}/${grade.total}, false ${grade.falseClaims.length}, ` +
        `${episode.tokensIn} in / ${episode.tokensOut} out tokens, ${episode.toolCalls} calls, ${Math.round(episode.wallMs / 1000)} s`,
    )
  }
}

// Complete only when every selected episode ran (none skipped for the run budget).
const summary = flush(notRun.length === 0)
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
rmSync(workDir, { recursive: true, force: true })
const failed = rows.filter((r) => r.episode.stop === 'error')
if (failed.length > 0) {
  console.error(`${failed.length} episode(s) failed: ${failed.map((r) => `${r.task}/${r.arm}: ${redact(r.episode.error ?? '')}`).join('; ')}`)
  process.exit(1)
}
