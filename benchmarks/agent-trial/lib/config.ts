// Which model the trial runs, from the environment (#571). The owner provides
// no model API key for CI: without an agent credential the trial is skipped
// and the scheduled job still succeeds. Node-compatible.
//
//   AGENT_TRIAL_MODE      auto (default) | scripted
//   AGENT_TRIAL_API_KEY   the provider key: a secret of the `agent-trial`
//                         environment, which only `dev` may use
//   AGENT_TRIAL_HAS_KEY   'true' | 'false': what the gate job gets instead of
//                         the key (it only needs to know whether one exists)
//   AGENT_TRIAL_MODEL     the model name (variable)
//   AGENT_TRIAL_PROVIDER  openai (any OpenAI-compatible chat-completions API) |
//                         anthropic; default: anthropic for claude-* models, else openai
//   AGENT_TRIAL_BASE_URL  optional API base URL
//   AGENT_TRIAL_JUDGE     1 = also run the optional LLM judge (live mode only)

export const SKIP_NOTICE = 'skipped: no agent credential (#571)'

export type GateMode =
  | { mode: 'skip'; reason: string }
  | { mode: 'scripted' }
  | { mode: 'live'; provider: 'openai' | 'anthropic'; model: string; judge: boolean }

export type TrialMode = Exclude<GateMode, { mode: 'live' }> | (Extract<GateMode, { mode: 'live' }> & { apiKey: string; baseUrl?: string })

/** The gate's decision. `hasKey` defaults to AGENT_TRIAL_HAS_KEY, so the gate never sees the key itself. */
export function gateMode(env: Record<string, string | undefined>, hasKey = env.AGENT_TRIAL_HAS_KEY === 'true'): GateMode {
  const mode = (env.AGENT_TRIAL_MODE ?? '').trim() || 'auto'
  if (mode === 'scripted') return { mode: 'scripted' }
  if (mode !== 'auto') throw new Error(`AGENT_TRIAL_MODE must be auto or scripted, got ${mode}`)
  const model = (env.AGENT_TRIAL_MODEL ?? '').trim()
  if (!hasKey || !model) {
    const missing = [!hasKey && 'AGENT_TRIAL_API_KEY', !model && 'AGENT_TRIAL_MODEL'].filter(Boolean).join(' and ')
    return { mode: 'skip', reason: `${SKIP_NOTICE}: ${missing} not configured` }
  }
  const explicit = (env.AGENT_TRIAL_PROVIDER ?? '').trim()
  if (explicit && explicit !== 'openai' && explicit !== 'anthropic') throw new Error(`AGENT_TRIAL_PROVIDER must be openai or anthropic, got ${explicit}`)
  const provider = explicit === 'openai' || explicit === 'anthropic' ? explicit : model.startsWith('claude') ? 'anthropic' : 'openai'
  return { mode: 'live', provider, model, judge: env.AGENT_TRIAL_JUDGE === '1' }
}

/** The runner's mode: live only with the key itself (AGENT_TRIAL_HAS_KEY is ignored here). */
export function resolveMode(env: Record<string, string | undefined>): TrialMode {
  const apiKey = (env.AGENT_TRIAL_API_KEY ?? '').trim()
  const m = gateMode(env, apiKey !== '')
  if (m.mode !== 'live') return m
  const baseUrl = (env.AGENT_TRIAL_BASE_URL ?? '').trim()
  return { ...m, apiKey, ...(baseUrl ? { baseUrl } : {}) }
}
