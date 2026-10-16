import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ARMS, dryRunAnswer, dryRunPlan, parseArms, systemPrompt } from './arms.ts'
import { SKIP_NOTICE, gateMode, resolveMode } from './config.ts'
import { judgeAnswer, judgePrompt, parseVerdict } from './judge.ts'
import type { Model } from './model.ts'
import type { TaskFile } from './tasks.ts'
import { ELARA_TOOLS, LOCAL_TOOL_SPECS } from './tools.ts'

const file = JSON.parse(readFileSync(new URL('../tasks.json', import.meta.url), 'utf8')) as TaskFile

test('no agent credential: skip with the #571 notice (the owner provides no key for CI)', () => {
  for (const env of [{}, { AGENT_TRIAL_MODEL: 'gpt-x' }, { AGENT_TRIAL_API_KEY: 'k' }, { AGENT_TRIAL_API_KEY: ' ', AGENT_TRIAL_MODEL: ' ' }, { AGENT_TRIAL_MODE: 'auto' }]) {
    const m = resolveMode(env)
    assert.equal(m.mode, 'skip', JSON.stringify(env))
    assert.ok(m.mode === 'skip' && m.reason.startsWith(SKIP_NOTICE))
  }
  assert.equal(SKIP_NOTICE, 'skipped: no agent credential (#571)')
  const m = resolveMode({ AGENT_TRIAL_MODEL: 'gpt-x' })
  assert.ok(m.mode === 'skip' && m.reason.endsWith('AGENT_TRIAL_API_KEY not configured'))
})

test('scripted mode needs no credential', () => {
  assert.deepEqual(resolveMode({ AGENT_TRIAL_MODE: 'scripted' }), { mode: 'scripted' })
})

test('live mode: provider from AGENT_TRIAL_PROVIDER, else anthropic for claude-* models, else openai', () => {
  assert.deepEqual(resolveMode({ AGENT_TRIAL_API_KEY: 'k', AGENT_TRIAL_MODEL: 'claude-sonnet' }), { mode: 'live', provider: 'anthropic', model: 'claude-sonnet', apiKey: 'k', judge: false })
  assert.deepEqual(resolveMode({ AGENT_TRIAL_API_KEY: 'k', AGENT_TRIAL_MODEL: 'gpt-x', AGENT_TRIAL_BASE_URL: 'https://llm.example/v1', AGENT_TRIAL_JUDGE: '1' }), {
    mode: 'live',
    provider: 'openai',
    model: 'gpt-x',
    apiKey: 'k',
    baseUrl: 'https://llm.example/v1',
    judge: true,
  })
  const explicit = resolveMode({ AGENT_TRIAL_API_KEY: 'k', AGENT_TRIAL_MODEL: 'claude-via-proxy', AGENT_TRIAL_PROVIDER: 'openai' })
  assert.ok(explicit.mode === 'live' && explicit.provider === 'openai')
  assert.throws(() => resolveMode({ AGENT_TRIAL_API_KEY: 'k', AGENT_TRIAL_MODEL: 'm', AGENT_TRIAL_PROVIDER: 'gemini' }), /openai or anthropic/)
  assert.throws(() => resolveMode({ AGENT_TRIAL_MODE: 'live' }), /auto or scripted/)
})

test('the gate decides from AGENT_TRIAL_HAS_KEY and never needs the key; the runner needs the key itself', () => {
  assert.deepEqual(gateMode({ AGENT_TRIAL_HAS_KEY: 'true', AGENT_TRIAL_MODEL: 'claude-sonnet' }), { mode: 'live', provider: 'anthropic', model: 'claude-sonnet', judge: false })
  for (const env of [{ AGENT_TRIAL_HAS_KEY: 'false', AGENT_TRIAL_MODEL: 'm' }, { AGENT_TRIAL_MODEL: 'm' }, { AGENT_TRIAL_HAS_KEY: 'true' }]) {
    const m = gateMode(env)
    assert.ok(m.mode === 'skip' && m.reason.startsWith(SKIP_NOTICE), JSON.stringify(env))
  }
  assert.deepEqual(gateMode({ AGENT_TRIAL_MODE: 'scripted' }), { mode: 'scripted' })
  // A forged boolean cannot make the runner go live without the key.
  assert.equal(resolveMode({ AGENT_TRIAL_HAS_KEY: 'true', AGENT_TRIAL_MODEL: 'm' }).mode, 'skip')
})

test('arms: both by default, unknown refused', () => {
  assert.deepEqual(parseArms(''), ['elara', 'local'])
  assert.deepEqual(parseArms('local'), ['local'])
  assert.deepEqual(parseArms('local, elara'), ['elara', 'local'])
  assert.throws(() => parseArms('elara,web'), /unknown arms web/)
})

test('system prompts: same rules for both arms, each names its only source', () => {
  const elara = systemPrompt('elara', { maxToolCalls: 30, repositoryId: 'r-1' })
  const local = systemPrompt('local', { maxToolCalls: 30 })
  assert.match(elara, /Elara/)
  assert.match(elara, /repositoryId r-1/)
  assert.match(local, /checkout/)
  for (const p of [elara, local]) {
    assert.match(p, /file:line evidence/)
    assert.match(p, /at most 30 tool calls/)
    assert.match(p, /do not answer from memory/)
  }
})

test('dry-run plans only use their arm tools and reference evidence of the task', () => {
  const localNames = LOCAL_TOOL_SPECS.map((t) => t.name)
  for (const t of file.tasks) {
    for (const arm of ARMS) {
      const plan = dryRunPlan(t, arm)
      assert.equal(plan.length, 3)
      for (const step of plan) assert.ok((arm === 'elara' ? ELARA_TOOLS : localNames).includes(step.name), `${t.id}/${arm}: ${step.name}`)
      assert.equal(plan[2]!.args.path, t.facts[0]!.evidence[0]!.path)
    }
    const grep = dryRunPlan(t, 'local')[1]!
    assert.ok(new RegExp(String(grep.args.pattern)).test(t.facts[0]!.evidence[0]!.contains), `${t.id}: grep pattern does not match its anchor`)
  }
  assert.match(dryRunAnswer([{ callId: 'c', name: 'grep', text: 'a\nb', isError: false }]), /^DRY RUN: scripted model[^\n]*\n- grep: ok, 3 characters: a b$/)
})

test('judge: prompt lists the facts; verdict keeps booleans for known facts only', () => {
  const t = file.tasks[0]!
  const prompt = judgePrompt(t, 'the answer')
  for (const f of t.facts) assert.ok(prompt.includes(`- ${f.id}: ${f.fact}`))
  assert.deepEqual(parseVerdict(t, 'Sure: {"T1.1": true, "T1.2": false, "T1.3": "yes", "T9.9": true}'), { 'T1.1': true, 'T1.2': false })
  assert.equal(parseVerdict(t, 'no json'), null)
  assert.equal(parseVerdict(t, '{broken'), null)
})

test('judge: runs one tool-less turn and counts the facts judged stated', async () => {
  const t = file.tasks[0]!
  const seen: unknown[] = []
  const model = (text: string): Model => ({
    provider: 'anthropic',
    name: 'judge',
    async complete(req) {
      seen.push([req.tools.length, req.toolChoice, req.signal instanceof AbortSignal])
      return { text, toolCalls: [], usage: { input: 10, output: 3 }, stop: 'end_turn' }
    },
  })
  const budget = { tokensLeft: 100_000, timeoutMs: 60_000 }
  const r = await judgeAnswer(model('{"T1.1": true, "T1.4": true, "T1.5": false}'), t, 'answer', budget)
  assert.deepEqual(r, { facts: { 'T1.1': true, 'T1.4': true, 'T1.5': false }, found: 2, usage: { input: 10, output: 3 } })
  const bad = await judgeAnswer(model('I cannot'), t, 'answer', budget)
  assert.equal(bad.found, 0)
  assert.match(bad.error!, /no JSON verdict/)
  // Not run when it does not fit in what is left of the task's token budget.
  const skipped = await judgeAnswer(model('{"T1.1": true}'), t, 'answer', { tokensLeft: 2_500, timeoutMs: 60_000 })
  assert.deepEqual(skipped.usage, { input: 0, output: 0 })
  assert.match(skipped.error!, /^not run: needs about \d+ tokens, 2500 left in the task budget$/)
  assert.deepEqual(seen, [
    [0, 'none', true],
    [0, 'none', true],
  ])
})
