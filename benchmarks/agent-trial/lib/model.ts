import { setTimeout as sleep } from 'node:timers/promises'

// One model interface for the agent loop, with two wire formats: any
// OpenAI-compatible chat-completions API and the Anthropic messages API.
// Request building and response parsing are pure functions (unit-tested
// without network); `httpModel` only adds fetch and retries. Node-compatible.

export interface JsonObjectSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

export interface ToolSpec {
  name: string
  description: string
  parameters: JsonObjectSchema
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Set when the model sent arguments that are not a JSON object. */
  argsError?: string
}

export interface ToolResultPart {
  callId: string
  name: string
  text: string
  isError: boolean
}

export type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResultPart[] }

export interface CompletionRequest {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  /** 'none' asks for a final answer without tool calls. */
  toolChoice: 'auto' | 'none'
  maxOutputTokens: number
}

export interface Usage {
  input: number
  output: number
}

export interface ModelTurn {
  text: string
  toolCalls: ToolCall[]
  usage: Usage
  /** The provider's stop reason, verbatim. */
  stop: string
  /** True when usage is a characters/4 estimate (the scripted model), not provider-reported. */
  estimated?: boolean
}

export interface Model {
  readonly provider: 'openai' | 'anthropic' | 'scripted'
  readonly name: string
  complete(req: CompletionRequest): Promise<ModelTurn>
}

function parseArgs(raw: unknown): { args: Record<string, unknown>; argsError?: string } {
  let value = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { args: {} }
    try {
      value = JSON.parse(raw)
    } catch {
      return { args: {}, argsError: `arguments are not valid JSON: ${raw.slice(0, 200)}` }
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return { args: value as Record<string, unknown> }
  return { args: {}, argsError: 'arguments must be a JSON object' }
}

// ---------------------------------------------------------------- OpenAI

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export function openAiRequest(model: string, req: CompletionRequest): Record<string, unknown> {
  const messages: OpenAiMessage[] = [{ role: 'system', content: req.system }]
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.text })
    else if (m.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: m.text === '' ? null : m.text,
        ...(m.toolCalls.length > 0
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      })
    } else for (const r of m.results) messages.push({ role: 'tool', tool_call_id: r.callId, content: r.text })
  }
  return {
    model,
    messages,
    max_completion_tokens: req.maxOutputTokens,
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: req.toolChoice,
        }
      : {}),
  }
}

interface OpenAiResponse {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export function parseOpenAiResponse(body: unknown): ModelTurn {
  const r = body as OpenAiResponse
  const choice = r.choices?.[0]
  if (!choice?.message) throw new Error(`OpenAI-compatible response has no choices[0].message: ${JSON.stringify(body).slice(0, 300)}`)
  return {
    text: choice.message.content ?? '',
    toolCalls: (choice.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, ...parseArgs(c.function.arguments) })),
    usage: { input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 },
    stop: choice.finish_reason ?? 'unknown',
  }
}

// ---------------------------------------------------------------- Anthropic

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

export function anthropicRequest(model: string, req: CompletionRequest): Record<string, unknown> {
  const messages: AnthropicMessage[] = []
  // Tool results travel in a user message; consecutive user content is merged
  // because the API requires alternating roles.
  const pushUser = (blocks: AnthropicBlock[]) => {
    const last = messages.at(-1)
    if (last?.role === 'user') last.content.push(...blocks)
    else messages.push({ role: 'user', content: blocks })
  }
  for (const m of req.messages) {
    if (m.role === 'user') pushUser([{ type: 'text', text: m.text }])
    else if (m.role === 'tool') {
      pushUser(m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.callId, content: r.text, ...(r.isError ? { is_error: true } : {}) })))
    } else {
      const content: AnthropicBlock[] = []
      if (m.text !== '') content.push({ type: 'text', text: m.text })
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
      messages.push({ role: 'assistant', content })
    }
  }
  return {
    model,
    system: req.system,
    max_tokens: req.maxOutputTokens,
    messages,
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
          tool_choice: { type: req.toolChoice },
        }
      : {}),
  }
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
}

export function parseAnthropicResponse(body: unknown): ModelTurn {
  const r = body as AnthropicResponse
  if (!Array.isArray(r.content)) throw new Error(`Anthropic response has no content: ${JSON.stringify(body).slice(0, 300)}`)
  const u = r.usage ?? {}
  return {
    text: r.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
    toolCalls: r.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id ?? '', name: b.name ?? '', ...parseArgs(b.input) })),
    // Cached prompt tokens are still input the model read.
    usage: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0 },
    stop: r.stop_reason ?? 'unknown',
  }
}

// ---------------------------------------------------------------- HTTP

export interface HttpModelConfig {
  provider: 'openai' | 'anthropic'
  model: string
  apiKey: string
  /** OpenAI: up to and including /v1 (default https://api.openai.com/v1). Anthropic: the host (default https://api.anthropic.com). */
  baseUrl?: string
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch
  timeoutMs?: number
  /** First retry delay; doubles per attempt (default 2000). */
  retryDelayMs?: number
}

const RETRIABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529])

export function httpModel(cfg: HttpModelConfig): Model {
  const doFetch = cfg.fetch ?? fetch
  const openai = cfg.provider === 'openai'
  const url = openai
    ? `${(cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`
    : `${(cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`
  const headers: Record<string, string> = openai
    ? { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` }
    : { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }
  return {
    provider: cfg.provider,
    name: cfg.model,
    async complete(req) {
      const body = JSON.stringify(openai ? openAiRequest(cfg.model, req) : anthropicRequest(cfg.model, req))
      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(cfg.timeoutMs ?? 300_000) })
        const text = await res.text()
        if (res.ok) {
          const parsed: unknown = JSON.parse(text)
          return openai ? parseOpenAiResponse(parsed) : parseAnthropicResponse(parsed)
        }
        if (!RETRIABLE.has(res.status) || attempt >= 4) {
          throw new Error(`${cfg.provider} ${res.status}: ${text.split(cfg.apiKey).join('***').slice(0, 500)}`)
        }
        await sleep(Math.min(60_000, (cfg.retryDelayMs ?? 2_000) * 2 ** attempt))
      }
    },
  }
}

// ---------------------------------------------------------------- scripted

/** Characters / 4: the same token estimate as the premise benchmark. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * A deterministic fake model for dry runs and tests: turn i issues the i-th
 * planned tool call, then answers with `answer(results)`. Usage is a
 * characters/4 estimate of what a real model would have read and written.
 */
export function scriptedModel(plan: Array<{ name: string; args: Record<string, unknown> }>, answer: (results: ToolResultPart[]) => string): Model {
  return {
    provider: 'scripted',
    name: 'scripted',
    async complete(req) {
      const results = req.messages.flatMap((m) => (m.role === 'tool' ? m.results : []))
      const input = estimateTokens(req.system + JSON.stringify(req.tools) + JSON.stringify(req.messages))
      const step = req.messages.filter((m) => m.role === 'assistant').length
      if (req.toolChoice === 'auto' && step < plan.length) {
        const call = plan[step]!
        return { text: '', toolCalls: [{ id: `call_${step + 1}`, name: call.name, args: call.args }], usage: { input, output: estimateTokens(JSON.stringify(call)) }, stop: 'tool_use', estimated: true }
      }
      const text = answer(results)
      return { text, toolCalls: [], usage: { input, output: estimateTokens(text) }, stop: 'end_turn', estimated: true }
    },
  }
}
