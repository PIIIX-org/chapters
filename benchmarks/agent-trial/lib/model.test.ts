import assert from 'node:assert/strict'
import { test } from 'node:test'
import { anthropicRequest, httpModel, openAiRequest, parseAnthropicResponse, parseOpenAiResponse, scriptedModel, type CompletionRequest } from './model.ts'

const req: CompletionRequest = {
  system: 'sys',
  tools: [{ name: 'grep', description: 'search', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } }],
  toolChoice: 'auto',
  maxOutputTokens: 100,
  messages: [
    { role: 'user', text: 'task' },
    { role: 'assistant', text: 'looking', toolCalls: [{ id: 'c1', name: 'grep', args: { pattern: 'x' } }, { id: 'c2', name: 'grep', args: { pattern: 'y' } }] },
    {
      role: 'tool',
      results: [
        { callId: 'c1', name: 'grep', text: 'a.ts:1:x', isError: false },
        { callId: 'c2', name: 'grep', text: 'Error: bad', isError: true },
      ],
    },
    { role: 'user', text: 'answer now' },
  ],
}

test('OpenAI-compatible request: system first, tool calls with JSON-string arguments, one tool message per result', () => {
  assert.deepEqual(openAiRequest('gpt-x', req), {
    model: 'gpt-x',
    max_completion_tokens: 100,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: 'looking',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } },
          { id: 'c2', type: 'function', function: { name: 'grep', arguments: '{"pattern":"y"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.ts:1:x' },
      { role: 'tool', tool_call_id: 'c2', content: 'Error: bad' },
      { role: 'user', content: 'answer now' },
    ],
    tools: [{ type: 'function', function: { name: 'grep', description: 'search', parameters: req.tools[0]!.parameters } }],
    tool_choice: 'auto',
  })
  const none = openAiRequest('gpt-x', { ...req, toolChoice: 'none', messages: [{ role: 'assistant', text: '', toolCalls: [] }] })
  assert.equal(none.tool_choice, 'none')
  assert.deepEqual(none.messages, [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: null },
  ])
})

test('OpenAI-compatible response: text, tool calls with parsed arguments, usage, finish reason', () => {
  const turn = parseOpenAiResponse({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } },
            { id: 'b', type: 'function', function: { name: 'grep', arguments: '{oops' } },
            { id: 'c', type: 'function', function: { name: 'list_files', arguments: '' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 30 },
  })
  assert.equal(turn.text, '')
  assert.equal(turn.stop, 'tool_calls')
  assert.deepEqual(turn.usage, { input: 1200, output: 30 })
  assert.deepEqual(turn.toolCalls[0], { id: 'a', name: 'grep', args: { pattern: 'x' } })
  assert.deepEqual(turn.toolCalls[1]!.args, {})
  assert.match(turn.toolCalls[1]!.argsError!, /not valid JSON/)
  assert.deepEqual(turn.toolCalls[2], { id: 'c', name: 'list_files', args: {} })
  assert.throws(() => parseOpenAiResponse({ error: { message: 'x' } }), /no choices/)
})

test('Anthropic request: system apart, tool_use blocks, tool results and the next user text merged into one user turn', () => {
  assert.deepEqual(anthropicRequest('claude-x', { ...req, toolChoice: 'none' }), {
    model: 'claude-x',
    system: 'sys',
    max_tokens: 100,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'looking' },
          { type: 'tool_use', id: 'c1', name: 'grep', input: { pattern: 'x' } },
          { type: 'tool_use', id: 'c2', name: 'grep', input: { pattern: 'y' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'a.ts:1:x' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'Error: bad', is_error: true },
          { type: 'text', text: 'answer now' },
        ],
      },
    ],
    tools: [{ name: 'grep', description: 'search', input_schema: req.tools[0]!.parameters }],
    tool_choice: { type: 'none' },
  })
})

test('Anthropic response: joined text, tool_use calls, cached input counted as input', () => {
  const turn = parseAnthropicResponse({
    content: [
      { type: 'text', text: 'Let me ' },
      { type: 'text', text: 'check.' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 7 },
  })
  assert.equal(turn.text, 'Let me check.')
  assert.deepEqual(turn.toolCalls, [{ id: 't1', name: 'read_file', args: { path: 'a.ts' } }])
  assert.deepEqual(turn.usage, { input: 125, output: 7 })
  assert.equal(turn.stop, 'tool_use')
  assert.throws(() => parseAnthropicResponse({ type: 'error' }), /no content/)
})

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) })
    const next = responses.shift()!
    return new Response(JSON.stringify(next.body), { status: next.status })
  }
  return { seen, impl: impl as typeof fetch }
}

test('httpModel: OpenAI endpoint and bearer header, retries a 429, then parses', async () => {
  const f = fakeFetch([
    { status: 429, body: { error: 'slow down' } },
    { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'done' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } } },
  ])
  const model = httpModel({ provider: 'openai', model: 'gpt-x', apiKey: 'sk-secret', baseUrl: 'https://llm.example/v1/', fetch: f.impl, retryDelayMs: 1 })
  const turn = await model.complete(req)
  assert.equal(turn.text, 'done')
  assert.equal(f.seen.length, 2)
  assert.equal(f.seen[0]!.url, 'https://llm.example/v1/chat/completions')
  assert.equal(f.seen[0]!.headers.authorization, 'Bearer sk-secret')
  assert.equal(f.seen[0]!.body.model, 'gpt-x')
})

test('httpModel: Anthropic endpoint and headers; a non-retriable error throws without the key', async () => {
  const f = fakeFetch([{ status: 401, body: { error: { message: 'invalid x-api-key sk-ant-secret' } } }])
  const model = httpModel({ provider: 'anthropic', model: 'claude-x', apiKey: 'sk-ant-secret', fetch: f.impl, retryDelayMs: 1 })
  await assert.rejects(model.complete(req), (err: Error) => err.message.startsWith('anthropic 401') && !err.message.includes('sk-ant-secret') && err.message.includes('***'))
  assert.equal(f.seen[0]!.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(f.seen[0]!.headers['x-api-key'], 'sk-ant-secret')
  assert.equal(f.seen[0]!.headers['anthropic-version'], '2023-06-01')
})

test('scriptedModel: one planned call per turn, then the answer; estimated usage; none means answer now', async () => {
  const model = scriptedModel([{ name: 'grep', args: { pattern: 'x' } }], (results) => `got ${results.length}`)
  const first = await model.complete({ ...req, messages: [{ role: 'user', text: 'task' }] })
  assert.deepEqual(first.toolCalls, [{ id: 'call_1', name: 'grep', args: { pattern: 'x' } }])
  assert.equal(first.estimated, true)
  assert.ok(first.usage.input > 0)
  const done = await model.complete({ ...req, messages: req.messages.slice(0, 3) })
  assert.equal(done.text, 'got 2')
  assert.deepEqual(done.toolCalls, [])
  const forced = await model.complete({ ...req, toolChoice: 'none', messages: [{ role: 'user', text: 'task' }] })
  assert.equal(forced.text, 'got 0')
})
