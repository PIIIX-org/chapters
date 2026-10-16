// The one agent loop both arms run: the model sees the task and its arm's
// tools, calls tools until it answers or a cap is reached, then must answer
// without tools. Records what the trial reports per task: tokens in/out,
// tool calls, turns, wall time, the answer and a trace. Node-compatible.
import type { Message, Model, ToolCall, ToolResultPart, Usage } from './model.ts'
import type { Toolset } from './tools.ts'

export interface Caps {
  /** Tool calls per task; calls beyond it are refused and the model must answer. */
  maxToolCalls: number
  /** Input + output tokens per task, summed over turns (what a provider bills). */
  maxTokens: number
  /** Output tokens per model turn. */
  maxOutputTokens: number
  /** A tool result longer than this is cut (characters). */
  maxToolResultChars: number
  /** Wall time per task. */
  maxWallMs: number
}

/**
 * 30 calls: the round-2 agents' cap. 100,000 characters per result (25,000
 * tokens), as in the premise benchmark. 600,000 tokens bounds the cost of a
 * task: the whole context is sent again on every turn.
 */
export const DEFAULT_CAPS: Caps = {
  maxToolCalls: 30,
  maxTokens: 600_000,
  maxOutputTokens: 8_192,
  maxToolResultChars: 100_000,
  maxWallMs: 20 * 60_000,
}

export interface TraceEntry {
  turn: number
  tool: string
  args: Record<string, unknown>
  chars: number
  truncated: boolean
  isError: boolean
  ms: number
  /** The first 300 characters of the result. */
  preview: string
}

export type StopReason = 'answered' | 'cap:tool-calls' | 'cap:tokens' | 'cap:wall-time' | 'error'

export interface EpisodeResult {
  answer: string
  stop: StopReason
  /** Provider error text when stop is 'error'. */
  error?: string
  tokensIn: number
  tokensOut: number
  /** True when token counts are characters/4 estimates (scripted model). */
  tokensEstimated: boolean
  toolCalls: number
  turns: number
  wallMs: number
  trace: TraceEntry[]
}

export interface Episode {
  model: Model
  tools: Toolset
  system: string
  prompt: string
  caps: Caps
  /** Injected in tests. */
  now?: () => number
}

export async function runEpisode(e: Episode): Promise<EpisodeResult> {
  const now = e.now ?? (() => performance.now())
  const t0 = now()
  const messages: Message[] = [{ role: 'user', text: e.prompt }]
  const used: Usage = { input: 0, output: 0 }
  const trace: TraceEntry[] = []
  let estimated = false
  let calls = 0
  let turns = 0
  let cap: StopReason | null = null
  const result = (answer: string, stop: StopReason, error?: string): EpisodeResult => ({
    answer,
    stop,
    ...(error === undefined ? {} : { error }),
    tokensIn: used.input,
    tokensOut: used.output,
    tokensEstimated: estimated,
    toolCalls: calls,
    turns,
    wallMs: Math.round(now() - t0),
    trace,
  })

  for (;;) {
    if (cap === null) {
      if (calls >= e.caps.maxToolCalls) cap = 'cap:tool-calls'
      else if (used.input + used.output >= e.caps.maxTokens) cap = 'cap:tokens'
      else if (now() - t0 >= e.caps.maxWallMs) cap = 'cap:wall-time'
      if (cap !== null) {
        messages.push({
          role: 'user',
          text: `The budget for this task is spent (${cap.slice(4)}). Do not call any more tools: give your final answer now, from what you have found.`,
        })
      }
    }
    let turn
    try {
      turn = await e.model.complete({ system: e.system, messages, tools: e.tools.specs, toolChoice: cap === null ? 'auto' : 'none', maxOutputTokens: e.caps.maxOutputTokens })
    } catch (err) {
      return result('', 'error', err instanceof Error ? err.message : String(err))
    }
    turns++
    used.input += turn.usage.input
    used.output += turn.usage.output
    estimated ||= turn.estimated === true
    messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls })
    if (turn.toolCalls.length === 0 || cap !== null) return result(turn.text, cap ?? 'answered')

    const results: ToolResultPart[] = []
    for (const call of turn.toolCalls) results.push(await runCall(e, call, calls++ < e.caps.maxToolCalls, turns, trace, now))
    calls = Math.min(calls, e.caps.maxToolCalls)
    messages.push({ role: 'tool', results })
  }
}

async function runCall(e: Episode, call: ToolCall, allowed: boolean, turn: number, trace: TraceEntry[], now: () => number): Promise<ToolResultPart> {
  if (!allowed) return { callId: call.id, name: call.name, text: 'Error: not run, the tool-call budget is spent', isError: true }
  const t0 = now()
  const out = call.argsError
    ? { text: `Error: ${call.argsError}`, isError: true }
    : await e.tools.run(call.name, call.args).catch((err: unknown) => ({ text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }))
  const truncated = out.text.length > e.caps.maxToolResultChars
  const text = truncated ? `${out.text.slice(0, e.caps.maxToolResultChars)}\n[truncated: ${out.text.length} characters, showing the first ${e.caps.maxToolResultChars}]` : out.text
  trace.push({ turn, tool: call.name, args: call.args, chars: out.text.length, truncated, isError: out.isError, ms: Math.round(now() - t0), preview: out.text.slice(0, 300) })
  return { callId: call.id, name: call.name, text, isError: out.isError }
}
