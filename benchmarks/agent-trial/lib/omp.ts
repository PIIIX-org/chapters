import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { CompletionRequest, Model, ModelTurn, ToolCall } from './model.ts'

const ENV_KEYS = ['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG']
const API = 'openai-codex-responses'
const PROVIDER = 'openai-codex'
const ORIGIN = 'https://chatgpt.com/backend-api'
const ISOLATION = {
  autoResume: false, 'retry.enabled': false, 'providers.cacheWarming': 'off',
  'advisor.enabled': false, 'compaction.enabled': false, 'ttsr.enabled': false,
  'mcp.enableProjectConfig': false,
  disabledProviders: ['anthropic', 'openrouter', 'claude', 'codex', 'gemini', 'agents', 'github', 'native'],
}
interface NativeMessage {
  role: string
  content: Array<{ type: string; text?: string; textSignature?: string }>
  api: string
  provider: string
  model: string
  usage: Record<string, unknown>
  stopReason: string
  errorMessage?: string
}

export function parseOmpAnswer(message: Pick<NativeMessage, 'content'>, req: Pick<CompletionRequest, 'tools'>, id: string): Pick<ModelTurn, 'text' | 'toolCalls' | 'error'> {
  try {
    const parts = message.content.filter((c) => c.type === 'text').map((c) => {
      const signature: unknown = c.textSignature ? JSON.parse(c.textSignature) : null
      if (!signature || typeof signature !== 'object' || !('phase' in signature) || (signature.phase !== 'commentary' && signature.phase !== 'final_answer')) {
        throw new Error('Missing or unsupported native text phase')
      }
      return { text: c.text ?? '', phase: signature.phase }
    })
    const final = parts.filter((c) => c.phase === 'final_answer')
    if (final.length !== 1) throw new Error('Expected one native final_answer phase')
    let text = final[0]!.text
    let toolCalls: ToolCall[] = []
    // Native reports are text; only a whole JSON envelope can request tools.
    // Never extract executable JSON from prose or a Markdown code fence.
    if (text.trimStart().startsWith('{')) {
      const answer = JSON.parse(text) as { text?: unknown; tool_calls?: unknown }
      if (typeof answer.text !== 'string' || !Array.isArray(answer.tool_calls)) throw new Error('Expected text and tool_calls')
      toolCalls = answer.tool_calls.map((call: { name?: unknown; arguments?: unknown }, index) => {
        if (typeof call.name !== 'string' || !req.tools.some((t) => t.name === call.name)) throw new Error('Unknown tool')
        const value: unknown = call.arguments
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be an object')
        return { id: `${id}:${index}`, name: call.name, args: value as Record<string, unknown> }
      })
      text = answer.text
    }
    return { text: [...parts.filter((c) => c.phase === 'commentary').map((c) => c.text), text].filter(Boolean).join('\n'), toolCalls }
  } catch (err) {
    // Preserve actual provider accounting even when the model violates the response protocol.
    return { text: '', toolCalls: [], error: `Invalid native answer protocol: ${err instanceof Error ? err.message : String(err)}; raw answer retained in events` }
  }
}

/** Native omp owns OAuth. Every request is stateless, with full explicit harness history and no native tools. */
export function ompSubscriptionModel(model: string, evidenceDir: string): Model {
  if (!model.trim()) throw new Error('A pinned native GPT model is required')
  const root = resolve(evidenceDir)
  mkdirSync(root, { recursive: true })
  const env = Object.fromEntries(ENV_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  const cliVersion = execFileSync('omp', ['--version'], { env, encoding: 'utf8', timeout: 10_000 }).trim()
  // Keep natural prefix-cache routing stable across stateless turns, never warm it artificially.
  const promptCacheKey = randomUUID()
  return {
    provider: PROVIDER, name: model, outputLimit: 'reported',
    async complete(req): Promise<ModelTurn> {
      const dir = mkdtempSync(join(root, 'turn-'))
      const config = join(dir, 'isolation.json')
      writeFileSync(config, JSON.stringify({ ...ISOLATION, enabledModels: [`${PROVIDER}/${model}`] }))
      const instructions = 'You are the model in a controlled benchmark. This invocation is ONE model turn, not the entire task. The JSON-listed tools are real external harness capabilities, not native runtime tools or hypothetical APIs. To request evidence, emit exactly one whole JSON object {"text":string,"tool_calls":[{"name":string,"arguments":object}]} in final_answer, without a code fence, and END YOUR TURN IMMEDIATELY. Do not put actionable JSON in commentary, wait for results inside this invocation, or append a report claiming these external tools are unavailable. The external harness executes your requested calls and invokes you again with genuine results in the explicit full history. When you have enough evidence, return your actual final report as plain text/Markdown, or the JSON object with tool_calls:[]. JSON embedded in prose is never executed. Follow the supplied system rules and toolChoice; none means a final answer without calls. Never use native runtime tools, delegation, unprovided context or memory. Supplied external tool results are allowed evidence. The requested output budget is recorded and enforced after provider usage; an overrun ends the episode without retry.'
      const payload = JSON.stringify({ id: 'turn', type: 'prompt', message: JSON.stringify({ system: req.system, tools: req.tools, messages: req.messages, toolChoice: req.toolChoice, maxOutputTokens: req.maxOutputTokens }) })
      const args = ['--mode', 'rpc', '--model', `${PROVIDER}/${model}`, '--prompt-cache-key', promptCacheKey, '--thinking', 'medium', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp', '--no-title', '--no-session', '--no-prewalk', '--config', config, '--system-prompt', instructions]
      return new Promise<ModelTurn>((resolveTurn, reject) => {
        const child = spawn('omp', args, { cwd: dir, env, signal: req.signal, stdio: ['pipe', 'pipe', 'pipe'] })
        const lines = createInterface({ input: child.stdout })
        const evidence: unknown[] = []
        const answers: NativeMessage[] = []
        let stderr = ''
        let sessionId: string | undefined
        let version: string | undefined
        let proof = false
        let failure: Error | undefined
        const fail = (error: Error) => { failure ??= error; child.kill('SIGTERM') }
        child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr += text })
        child.stdin.on('error', (error) => fail(error))
        child.once('error', reject)
        lines.on('line', (line) => {
          try {
            const frame = JSON.parse(line) as Record<string, unknown>
            if (frame.type === 'ready') {
              version = String(frame.protocolVersion)
              if (Buffer.byteLength(payload) + 1 > Number(frame.maxFrameBytes)) throw new Error('Native RPC input exceeds its advertised frame limit; no request sent')
              child.stdin.write(JSON.stringify({ id: 'isolation', type: 'get_state' }) + '\n')
            } else if (frame.type === 'response' && frame.id === 'isolation') {
              const state = frame.data as { model: { id: string; provider: string; api: string; baseUrl: string }; dumpTools: unknown[]; messageCount: number; sessionId: string }
              const selected = state.model
              if (!frame.success || selected.id !== model || selected.provider !== PROVIDER || selected.api !== API || selected.baseUrl.replace(/\/$/, '') !== ORIGIN || state.dumpTools.length || state.messageCount !== 0) throw new Error('Native model/endpoint/tool/history isolation mismatch; no request sent')
              sessionId = state.sessionId
              proof = true
              // Keep only non-secret state metadata, never model headers or stored credentials.
              evidence.push({ type: 'isolation', threadId: sessionId, requestedPromptCacheKey: promptCacheKey, model: { id: selected.id, provider: selected.provider, api: selected.api, baseUrl: selected.baseUrl }, tools: [], messageCount: 0 })
              child.stdin.write(payload + '\n')
            } else {
              evidence.push(frame)
              if (frame.type === 'session') version = String(frame.version)
              if (frame.type === 'message_end') {
                const message = frame.message as NativeMessage
                if (message.role === 'assistant') answers.push(message)
              }
              if (frame.type === 'tool_execution_start' || frame.type === 'model_changed' || frame.type === 'retry_fallback_applied' || frame.type === 'auto_compaction_start') throw new Error('Unexpected native tool/model/retry/context change invalidates trial turn')
              if (frame.type === 'agent_end' && frame.isTerminal !== false) child.stdin.end()
              if (frame.type === 'prompt_result' && frame.status === 'error') throw new Error(String(frame.error ?? 'Native prompt failed'))
            }
          } catch (err) { fail(err instanceof Error ? err : new Error(String(err))) }
        })
        child.once('close', (code) => {
          lines.close()
          writeFileSync(join(dir, 'events.jsonl'), evidence.map((e) => JSON.stringify(e)).join('\n') + '\n')
          if (stderr) writeFileSync(join(dir, 'stderr.log'), stderr)
          if (failure) return reject(failure)
          if (code !== 0 || !proof || answers.length !== 1 || !sessionId) return reject(new Error(`Native omp exited ${code}; expected one isolated provider turn, got ${answers.length}; evidence: ${dir}`))
          const answer = answers[0]!
          if (answer.model !== model || answer.provider !== PROVIDER || answer.api !== API) return reject(new Error('Returned native model identity differs from the pinned model'))
          const usage = answer.usage
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
            if (!Number.isSafeInteger(usage?.[key]) || Number(usage[key]) < 0) return reject(new Error(`Native provider usage lacks ${key}; no estimated fallback`))
          }
          const input = Number(usage.input) + Number(usage.cacheRead) + Number(usage.cacheWrite)
          if (input + Number(usage.output) !== usage.totalTokens) return reject(new Error('Native provider token totals do not reconcile'))
          resolveTurn({
            ...parseOmpAnswer(answer, req, sessionId), stop: answer.stopReason,
            ...(answer.errorMessage ? { error: answer.errorMessage } : {}),
            usage: { input, output: Number(usage.output), uncachedInput: Number(usage.input), cachedInput: Number(usage.cacheRead), cacheWriteInput: Number(usage.cacheWrite) },
            native: { transport: 'omp-rpc', cliVersion, protocolVersion: version, auth: 'chatgpt', model, provider: PROVIDER, api: API, endpoint: ORIGIN, threadId: sessionId, usage },
          })
        })
      })
    },
  }
}
