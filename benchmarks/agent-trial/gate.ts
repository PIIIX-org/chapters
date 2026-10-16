// The agent-trial workflow's gate (#571): decides from the environment
// whether the trial job runs, before any runner builds the lab instance.
// Without an agent credential it reports the skip notice and succeeds.
//   node benchmarks/agent-trial/gate.ts
// Writes run=true|false and mode=live|scripted|skip to $GITHUB_OUTPUT and a
// line to $GITHUB_STEP_SUMMARY. Never prints the key.
import { appendFileSync } from 'node:fs'
import { resolveMode } from './lib/config.ts'

const mode = resolveMode(process.env)
const line =
  mode.mode === 'skip'
    ? mode.reason
    : mode.mode === 'scripted'
      ? 'dry run: scripted model against the lab instance (not agent numbers)'
      : `live: ${mode.provider} model ${mode.model}${mode.judge ? ', with the optional LLM judge' : ''}`
console.log(mode.mode === 'skip' ? `::notice title=Agent trial::${line}` : line)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${mode.mode !== 'skip'}\nmode=${mode.mode}\n`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Agent trial: **${line}**\n`)
