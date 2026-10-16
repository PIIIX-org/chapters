// Which model the trial runs, from the environment (#571). The owner provides
// no model API key for CI: without an agent credential the trial is skipped
// and the scheduled job still succeeds. Node-compatible.
//
//   AGENT_TRIAL_MODE      auto (default) | scripted
//   AGENT_TRIAL_API_KEY   the provider key (repository secret)
//   AGENT_TRIAL_MODEL     the model name (repository variable or secret)
//   AGENT_TRIAL_PROVIDER  openai (any OpenAI-compatible chat-completions API) |
//                         anthropic; default: anthropic for claude-* models, else openai
//   AGENT_TRIAL_BASE_URL  optional API base URL
//   AGENT_TRIAL_JUDGE     1 = also run the optional LLM judge (live mode only)

export const SKIP_NOTICE = 'skipped: no agent credential (#571)'

export type TrialMode =
  | { mode: 'skip'; reason: string }
  | { mode: 'scripted' }
  | { mode: 'live'; provider: 'openai' | 'anthropic'; model: string; apiKey: string; baseUrl?: string; judge: boolean }

export function resolveMode(env: Record<string, string | undefined>): TrialMode {
  const mode = (env.AGENT_TRIAL_MODE ?? '').trim() || 'auto'
  if (mode === 'scripted') return { mode: 'scripted' }
  if (mode !== 'auto') throw new Error(`AGENT_TRIAL_MODE must be auto or scripted, got ${mode}`)
  const apiKey = (env.AGENT_TRIAL_API_KEY ?? '').trim()
  const model = (env.AGENT_TRIAL_MODEL ?? '').trim()
  if (!apiKey || !model) {
    const missing = [!apiKey && 'AGENT_TRIAL_API_KEY', !model && 'AGENT_TRIAL_MODEL'].filter(Boolean).join(' and ')
    return { mode: 'skip', reason: `${SKIP_NOTICE}: ${missing} not configured` }
  }
  const explicit = (env.AGENT_TRIAL_PROVIDER ?? '').trim()
  if (explicit && explicit !== 'openai' && explicit !== 'anthropic') throw new Error(`AGENT_TRIAL_PROVIDER must be openai or anthropic, got ${explicit}`)
  const provider = explicit === 'openai' || explicit === 'anthropic' ? explicit : model.startsWith('claude') ? 'anthropic' : 'openai'
  const baseUrl = (env.AGENT_TRIAL_BASE_URL ?? '').trim()
  return { mode: 'live', provider, model, apiKey, ...(baseUrl ? { baseUrl } : {}), judge: env.AGENT_TRIAL_JUDGE === '1' }
}
