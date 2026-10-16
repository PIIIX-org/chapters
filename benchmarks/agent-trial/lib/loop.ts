// The one agent loop both arms run: the model sees the task and its arm's
// tools, calls tools until it answers or a cap is reached, then must answer
// without tools. Records what the trial reports per task: tokens in/out,
// tool calls, turns, wall time, the answer and a trace. Node-compatible.
//
// The caps hold before every model call, not between turns (#651 review):
// - tokens: a request is only sent when its estimated input plus its output
//   limit fits in what is left of `maxTokens`; a tool turn is only sent when
//   a final answer turn after it would still fit, and the final turn drops
//   the newest tool results if it has to.
// - wall time: tools stop at `maxWallMs` minus a reserve for the final
//   answer; every request carries an abort signal for the time left.
import { estimateRequestTokens, type CompletionRequest, type Message, type Model, type ToolCall, type ToolResultPart, type Usage } from './model.ts'
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
 * task: the whole context is sent again on every turn. 15 minutes per task:
 * 16 episodes plus their judge calls fit in the runner's 6-hour job limit.
 */
export const DEFAULT_CAPS: Caps = {
  maxToolCalls: 30,
  maxTokens: 600_000,
  maxOutputTokens: 8_192,
  maxToolResultChars: 100_000,
  maxWallMs: 15 * 60_000,
}

/**
 * Provider tokens per characters/4 assumed before the first reported usage:
 * code and JSON tokenize denser than prose. Afterwards the estimate uses the
 * largest ratio the provider has reported in this episode, plus 5 %.
 */
export const INITIAL_TOKEN_SCALE = 1.5
/** Below this many output tokens a final answer is not worth requesting. */
const MIN_FINAL_OUTPUT = 256

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
  /** Provider error text when stop is 'error'; why there is no answer when a cap left none. */
  error?: string
  tokensIn: number
  tokensOut: number
  /** True when token counts are characters/4 estimates (scripted model). */
  tokensEstimated: boolean
  toolCalls: number
  turns: number
  /** Requests aborted at the time limit (the provider may still bill them; not in tokensIn). */
  abortedTurns: number
  /** Tool results replaced by a stub so the final answer fit the token cap. */
  droppedResults: number
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

/** The time kept for the final answer: a fifth of the wall cap, at most 3 minutes. */
export function finalReserveMs(caps: Caps): number {
  return Math.min(3 * 60_000, Math.floor(caps.maxWallMs / 5))
}

export async function runEpisode(e: Episode): Promise<EpisodeResult> {
  const now = e.now ?? (() => performance.now())
  const t0 = now()
  const toolDeadline = e.caps.maxWallMs - finalReserveMs(e.caps)
  const messages: Message[] = [{ role: 'user', text: e.prompt }]
  const used: Usage = { input: 0, output: 0 }
  const trace: TraceEntry[] = []
  let scale = INITIAL_TOKEN_SCALE
  let calibrated = false
  let estimated = false
  let calls = 0
  let turns = 0
  let aborted = 0
  let dropped = 0
  let lastText = ''
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
    abortedTurns: aborted,
    droppedResults: dropped,
    wallMs: Math.round(now() - t0),
    trace,
  })
  const estimate = (req: Pick<CompletionRequest, 'system' | 'tools' | 'messages'>) => Math.ceil(estimateRequestTokens(req) * scale)
  const left = () => e.caps.maxTokens - used.input - used.output
  const force = (reason: StopReason) => {
    cap = reason
    messages.push({
      role: 'user',
      text: `The budget for this task is spent (${reason.slice(4)}). Do not call any more tools: give your final answer now, from what you have found.`,
    })
  }

  for (;;) {
    if (cap === null) {
      const autoReq = { system: e.system, messages, tools: e.tools.specs }
      const autoIn = estimate(autoReq)
      // The tool turn, then a final turn whose input is at most this turn's
      // input plus its output and the budget message (newer tool results
      // are dropped if needed), and that final turn's output.
      const worstCase = 2 * (autoIn + e.caps.maxOutputTokens) + 100 + e.caps.maxOutputTokens
      if (calls >= e.caps.maxToolCalls) force('cap:tool-calls')
      else if (now() - t0 >= toolDeadline) force('cap:wall-time')
      else if (worstCase > left()) force('cap:tokens')
    }

    let maxOutputTokens = e.caps.maxOutputTokens
    if (cap !== null) {
      // Fit the final request in what is left: newest tool results go first.
      const fits = () => estimate({ system: e.system, messages, tools: e.tools.specs }) + MIN_FINAL_OUTPUT <= left()
      for (let i = messages.length - 1; i >= 0 && !fits(); i--) {
        const m = messages[i]!
        if (m.role !== 'tool') continue
        messages[i] = {
          role: 'tool',
          results: m.results.map((r) => {
            if (r.text.startsWith('[dropped:')) return r
            dropped++
            return { ...r, text: `[dropped: ${r.text.length} characters, to keep the final answer within the token budget]` }
          }),
        }
      }
      if (!fits()) return result(lastText, cap, 'no final answer: the conversation alone exceeds the token budget')
      maxOutputTokens = Math.min(e.caps.maxOutputTokens, left() - estimate({ system: e.system, messages, tools: e.tools.specs }))
    }

    const timeLeft = (cap === null ? toolDeadline : e.caps.maxWallMs) - (now() - t0)
    if (cap !== null && timeLeft < Math.min(1_000, finalReserveMs(e.caps) / 2)) return result(lastText, cap, 'no final answer: the time budget is spent')
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(timeLeft)))
    const sentIn = estimateRequestTokens({ system: e.system, messages, tools: e.tools.specs })
    let turn
    try {
      turn = await e.model.complete({ system: e.system, messages, tools: e.tools.specs, toolChoice: cap === null ? 'auto' : 'none', maxOutputTokens, signal })
    } catch (err) {
      if (signal.aborted) {
        aborted++
        if (cap === null) {
          force('cap:wall-time')
          continue
        }
        return result(lastText, cap, 'no final answer: the final request timed out')
      }
      return result('', 'error', err instanceof Error ? err.message : String(err))
    }
    if (turn.estimated) scale = 1 // the scripted model reports exactly this estimate
    else if (turn.usage.input > 0) {
      const ratio = (turn.usage.input / sentIn) * 1.05
      scale = calibrated ? Math.max(scale, ratio) : ratio
      calibrated = true
    }
    turns++
    used.input += turn.usage.input
    used.output += turn.usage.output
    estimated ||= turn.estimated === true
    lastText = turn.text
    messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls })
    if (turn.toolCalls.length === 0 || cap !== null) return result(turn.text, cap ?? 'answered')

    const results: ToolResultPart[] = []
    for (const call of turn.toolCalls) {
      const refusal = calls >= e.caps.maxToolCalls ? 'the tool-call budget is spent' : now() - t0 >= toolDeadline ? 'the time budget is spent' : null
      if (refusal) results.push({ callId: call.id, name: call.name, text: `Error: not run, ${refusal}`, isError: true })
      else {
        calls++
        results.push(await runCall(e, call, turns, trace, now))
      }
    }
    messages.push({ role: 'tool', results })
  }
}

async function runCall(e: Episode, call: ToolCall, turn: number, trace: TraceEntry[], now: () => number): Promise<ToolResultPart> {
  const t0 = now()
  const out = call.argsError
    ? { text: `Error: ${call.argsError}`, isError: true }
    : await e.tools.run(call.name, call.args).catch((err: unknown) => ({ text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }))
  const truncated = out.text.length > e.caps.maxToolResultChars
  const text = truncated ? `${out.text.slice(0, e.caps.maxToolResultChars)}\n[truncated: ${out.text.length} characters, showing the first ${e.caps.maxToolResultChars}]` : out.text
  trace.push({ turn, tool: call.name, args: call.args, chars: out.text.length, truncated, isError: out.isError, ms: Math.round(now() - t0), preview: out.text.slice(0, 300) })
  return { callId: call.id, name: call.name, text, isError: out.isError }
}
