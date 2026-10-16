import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CAPS, runEpisode, type Caps } from './loop.ts'
import { scriptedModel, type CompletionRequest, type Model, type ModelTurn } from './model.ts'
import type { Toolset } from './tools.ts'

function fakeTools(results: Record<string, string> = {}): Toolset & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = []
  return {
    calls,
    specs: [{ name: 'grep', description: 'g', parameters: { type: 'object', properties: {} } }],
    async run(name, args) {
      calls.push([name, args])
      if (name === 'boom') throw new Error('tool crashed')
      return { text: results[name] ?? `${name} result`, isError: false }
    },
  }
}

/** A model that replays fixed turns and records every request. */
function replay(turns: ModelTurn[]): Model & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = []
  return {
    provider: 'openai',
    name: 'replay',
    requests,
    async complete(req) {
      requests.push(structuredClone(req))
      const next = turns.shift()
      if (!next) throw new Error('no more turns')
      return next
    },
  }
}

const call = (id: string, name = 'grep', args: Record<string, unknown> = { pattern: id }) => ({ id, name, args })
const turn = (toolCalls: ModelTurn['toolCalls'], text = '', usage = { input: 100, output: 10 }): ModelTurn => ({ text, toolCalls, usage, stop: toolCalls.length ? 'tool_calls' : 'stop' })
const caps = (over: Partial<Caps> = {}): Caps => ({ ...DEFAULT_CAPS, ...over })

test('the scripted model drives the loop end to end: planned calls, then the answer', async () => {
  const tools = fakeTools()
  const r = await runEpisode({
    model: scriptedModel([call('1'), call('2')], (results) => `answer from ${results.length} results`),
    tools,
    system: 'sys',
    prompt: 'task',
    caps: caps(),
  })
  assert.equal(r.stop, 'answered')
  assert.equal(r.answer, 'answer from 2 results')
  assert.equal(r.toolCalls, 2)
  assert.equal(r.turns, 3)
  assert.equal(r.tokensEstimated, true)
  assert.ok(r.tokensIn > 0 && r.tokensOut > 0)
  assert.deepEqual(tools.calls, [
    ['grep', { pattern: '1' }],
    ['grep', { pattern: '2' }],
  ])
  assert.deepEqual(
    r.trace.map((t) => [t.turn, t.tool, t.chars, t.isError]),
    [
      [1, 'grep', 11, false],
      [2, 'grep', 11, false],
    ],
  )
})

test('provider usage is summed over turns', async () => {
  const model = replay([turn([call('a')], '', { input: 1000, output: 50 }), turn([], 'final', { input: 1500, output: 200 })])
  const r = await runEpisode({ model, tools: fakeTools(), system: 's', prompt: 'p', caps: caps() })
  assert.deepEqual([r.tokensIn, r.tokensOut, r.tokensEstimated], [2500, 250, false])
  // The second request carries the call and its result.
  const second = model.requests[1]!
  assert.deepEqual(
    second.messages.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  )
  assert.equal(second.toolChoice, 'auto')
})

test('the tool-call cap refuses extra calls in a turn, then forces an answer without tools', async () => {
  const model = replay([turn([call('a'), call('b'), call('c')]), turn([], 'capped answer')])
  const tools = fakeTools()
  const r = await runEpisode({ model, tools, system: 's', prompt: 'p', caps: caps({ maxToolCalls: 2 }) })
  assert.equal(r.stop, 'cap:tool-calls')
  assert.equal(r.answer, 'capped answer')
  assert.equal(r.toolCalls, 2)
  assert.equal(tools.calls.length, 2)
  const final = model.requests[1]!
  assert.equal(final.toolChoice, 'none')
  const results = final.messages.find((m) => m.role === 'tool')
  assert.ok(results?.role === 'tool')
  assert.match(results.results[2]!.text, /budget is spent/)
  assert.match(JSON.stringify(final.messages.at(-1)), /give your final answer now/)
})

test('the token cap stops tool use once the summed usage reaches it', async () => {
  const model = replay([turn([call('a')], '', { input: 900, output: 100 }), turn([call('b')], 'partial', { input: 10, output: 5 })])
  const tools = fakeTools()
  const r = await runEpisode({ model, tools, system: 's', prompt: 'p', caps: caps({ maxTokens: 1000 }) })
  assert.equal(r.stop, 'cap:tokens')
  assert.equal(r.answer, 'partial')
  assert.equal(tools.calls.length, 1, 'no tool runs after the cap')
})

test('the wall-time cap uses the injected clock', async () => {
  let t = 0
  const model = replay([turn([call('a')]), turn([], 'late')])
  const r = await runEpisode({ model, tools: fakeTools(), system: 's', prompt: 'p', caps: caps({ maxWallMs: 50 }), now: () => (t += 30) })
  assert.equal(r.stop, 'cap:wall-time')
  assert.equal(r.answer, 'late')
})

test('long tool results are cut and marked; bad arguments and tool crashes become error results', async () => {
  const model = replay([turn([call('a'), { id: 'b', name: 'grep', args: {}, argsError: 'arguments are not valid JSON: {x' }, call('c', 'boom')]), turn([], 'ok')])
  const r = await runEpisode({ model, tools: fakeTools({ grep: 'x'.repeat(50) }), system: 's', prompt: 'p', caps: caps({ maxToolResultChars: 45 }) })
  const sent = model.requests[1]!.messages.find((m) => m.role === 'tool')
  assert.ok(sent?.role === 'tool')
  assert.equal(sent.results[0]!.text, `${'x'.repeat(45)}\n[truncated: 50 characters, showing the first 45]`)
  assert.equal(sent.results[1]!.text, 'Error: arguments are not valid JSON: {x')
  assert.equal(sent.results[2]!.text, 'Error: tool crashed')
  assert.deepEqual(
    r.trace.map((e) => [e.chars, e.truncated, e.isError]),
    [
      [50, true, false],
      [39, false, true],
      [19, false, true],
    ],
  )
})

test('a provider error ends the episode with stop error and the message', async () => {
  const model = replay([])
  const r = await runEpisode({ model, tools: fakeTools(), system: 's', prompt: 'p', caps: caps() })
  assert.equal(r.stop, 'error')
  assert.equal(r.error, 'no more turns')
  assert.equal(r.answer, '')
})
