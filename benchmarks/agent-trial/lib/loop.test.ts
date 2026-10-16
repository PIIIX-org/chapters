import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CAPS, runEpisode, type Caps } from './loop.ts'
import { estimateRequestTokens, scriptedModel, type CompletionRequest, type Model, type ModelTurn } from './model.ts'
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
      // An AbortSignal cannot be cloned; the tests read the rest.
      requests.push(structuredClone({ ...req, signal: undefined }))
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

/**
 * A model that reports `ratio` x characters/4 of each request as its input,
 * spends its whole output allowance, and calls `parallel` tools per turn
 * until it must answer: the #651 review's probe (901,625 and 1,501,568
 * tokens against a 600,000 cap before the fix).
 */
function greedy(ratio: number, parallel: number): Model & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = []
  return {
    provider: 'openai',
    name: 'greedy',
    requests,
    async complete(req) {
      requests.push({ ...req, messages: [...req.messages] })
      const usage = { input: Math.ceil(estimateRequestTokens(req) * ratio), output: req.maxOutputTokens }
      if (req.toolChoice === 'none') return { text: 'final', toolCalls: [], usage, stop: 'stop' }
      return { text: '', toolCalls: Array.from({ length: parallel }, (_, i) => call(`${requests.length}-${i}`)), usage, stop: 'tool_calls' }
    },
  }
}

test('the token cap holds before every model call, including the forced final answer (#651 review)', async () => {
  for (const [ratio, parallel] of [
    [1, 1],
    [1, 10],
    [1.3, 1],
    [1.3, 10],
  ] as const) {
    const model = greedy(ratio, parallel)
    const r = await runEpisode({ model, tools: fakeTools({ grep: 'x'.repeat(100_000) }), system: 's', prompt: 'p', caps: caps() })
    const label = `ratio ${ratio}, ${parallel} per turn`
    assert.equal(r.stop, 'cap:tokens', label)
    assert.equal(r.answer, 'final', label)
    assert.ok(r.tokensIn + r.tokensOut <= DEFAULT_CAPS.maxTokens, `${label}: ${r.tokensIn + r.tokensOut} tokens`)
    assert.equal(model.requests.at(-1)!.toolChoice, 'none', label)
    assert.ok(r.toolCalls > 0, label)
  }
})

test('the final turn drops the newest tool results when the answer would not fit otherwise', async () => {
  const model = greedy(1, 3)
  const r = await runEpisode({ model, tools: fakeTools({ grep: 'x'.repeat(100_000) }), system: 's', prompt: 'p', caps: caps({ maxTokens: 60_000, maxOutputTokens: 1_000 }) })
  assert.equal(r.stop, 'cap:tokens')
  assert.equal(r.answer, 'final')
  assert.equal(r.toolCalls, 3)
  assert.equal(r.droppedResults, 3)
  assert.ok(r.tokensIn + r.tokensOut <= 60_000, `${r.tokensIn + r.tokensOut} tokens`)
  assert.match(JSON.stringify(model.requests.at(-1)!.messages), /\[dropped: 100000 characters, to keep the final answer within the token budget\]/)
})

test('a provider that reports no usage: the loop counts estimates, the cap still holds, and the episode says tokensEstimated (#651 review 2)', async () => {
  for (const parallel of [1, 10]) {
    // What the provider would bill (characters / 4 of each request and of its reply), never reported.
    let billed = 0
    const silent: Model = {
      provider: 'openai',
      name: 'silent',
      async complete(req) {
        const reply: ModelTurn =
          req.toolChoice === 'none'
            ? { text: 'final', toolCalls: [], usage: null, stop: 'stop' }
            : { text: '', toolCalls: Array.from({ length: parallel }, (_, i) => call(`${billed}-${i}`)), usage: null, stop: 'tool_calls' }
        billed += estimateRequestTokens(req) + Math.ceil((reply.text + (reply.toolCalls.length > 0 ? JSON.stringify(reply.toolCalls) : '')).length / 4)
        return reply
      },
    }
    const r = await runEpisode({ model: silent, tools: fakeTools({ grep: 'x'.repeat(100_000) }), system: 's', prompt: 'p', caps: caps() })
    const label = `${parallel} per turn`
    assert.equal(r.tokensEstimated, true, label)
    assert.equal(r.stop, 'cap:tokens', label)
    assert.equal(r.answer, 'final', label)
    assert.ok(r.tokensIn > 0 && r.tokensOut > 0, label)
    assert.ok(billed <= DEFAULT_CAPS.maxTokens, `${label}: billed ${billed}`)
    assert.ok(r.tokensIn + r.tokensOut <= DEFAULT_CAPS.maxTokens, `${label}: counted ${r.tokensIn + r.tokensOut}`)
    assert.ok(r.tokensIn >= billed - r.tokensOut, `${label}: counted input ${r.tokensIn} below what was sent`)
  }
})

test('a budget too small for even the prompt ends without a model call', async () => {
  const model = greedy(1, 1)
  const r = await runEpisode({ model, tools: fakeTools(), system: 's', prompt: 'p'.repeat(4_000), caps: caps({ maxTokens: 900 }) })
  assert.equal(r.stop, 'cap:tokens')
  assert.equal(r.turns, 0)
  assert.match(r.error!, /exceeds the token budget/)
})

test('wall time: tools stop before the final-answer reserve, and the final turn still runs', async () => {
  let t = 0
  const model = replay([turn([call('a')]), turn([call('b')]), turn([], 'late')])
  const slow: Model = { ...model, complete: async (req) => ((t += 4_000), model.complete(req)) }
  const tools = fakeTools()
  // 10 s cap, 2 s reserve: tools until 8 s.
  const r = await runEpisode({ model: slow, tools, system: 's', prompt: 'p', caps: caps({ maxWallMs: 10_000 }), now: () => t })
  assert.equal(r.stop, 'cap:wall-time')
  assert.equal(r.answer, 'late')
  assert.deepEqual(tools.calls, [['grep', { pattern: 'a' }]])
  assert.match(JSON.stringify(model.requests[2]!.messages), /not run, the time budget is spent/)
  assert.equal(model.requests[2]!.toolChoice, 'none')
})

test('wall time: a request still running at the tool deadline is aborted and the model is asked to answer', async () => {
  const requests: CompletionRequest[] = []
  const hanging: Model = {
    provider: 'openai',
    name: 'hanging',
    async complete(req) {
      requests.push(req)
      if (req.toolChoice === 'none') return turn([], 'answer after abort')
      const { promise, reject } = Promise.withResolvers<ModelTurn>()
      req.signal!.addEventListener('abort', () => reject(req.signal!.reason))
      return promise
    },
  }
  const r = await runEpisode({ model: hanging, tools: fakeTools(), system: 's', prompt: 'p', caps: caps({ maxWallMs: 500 }) })
  assert.equal(r.stop, 'cap:wall-time')
  assert.equal(r.answer, 'answer after abort')
  assert.equal(r.abortedTurns, 1)
  assert.ok(r.wallMs < 500, `${r.wallMs} ms`)
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
