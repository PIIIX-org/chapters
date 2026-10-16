// Optional LLM judge (#571): runs only in live mode with AGENT_TRIAL_JUDGE=1,
// and is recorded next to the deterministic grade, never instead of it. The
// judge reads the task's key facts and the answer and says, per fact,
// whether the answer states it (paraphrases count). Node-compatible.
import type { Model, Usage } from './model.ts'
import type { Task } from './tasks.ts'

export interface JudgeResult {
  /** fact id -> stated; facts the judge did not rule on are absent. */
  facts: Record<string, boolean>
  found: number
  usage: Usage
  /** Set when the reply held no usable verdict. */
  error?: string
}

export function judgePrompt(task: Task, answer: string): string {
  return [
    'You grade an answer to a question about a code repository against a list of key facts.',
    'For each fact, decide whether the answer states it (in any wording). Do not reward facts the answer only hints at, and do not judge anything else.',
    'Reply with only a JSON object mapping each fact id to true or false, for example {"T1.1": true, "T1.2": false}.',
    '',
    `Question: ${task.prompt}`,
    '',
    'Key facts:',
    ...task.facts.map((f) => `- ${f.id}: ${f.fact}`),
    '',
    'Answer:',
    '<<<',
    answer,
    '>>>',
  ].join('\n')
}

/** The verdicts in a judge reply: the first JSON object in it, booleans for known fact ids only. */
export function parseVerdict(task: Task, reply: string): Record<string, boolean> | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let value: unknown
  try {
    value = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const out: Record<string, boolean> = {}
  for (const f of task.facts) {
    const v: unknown = Reflect.get(value, f.id)
    if (typeof v === 'boolean') out[f.id] = v
  }
  return out
}

export async function judgeAnswer(model: Model, task: Task, answer: string): Promise<JudgeResult> {
  const turn = await model.complete({
    system: 'You are a strict, literal grader. Reply with JSON only.',
    messages: [{ role: 'user', text: judgePrompt(task, answer) }],
    tools: [],
    toolChoice: 'none',
    maxOutputTokens: 2_048,
  })
  const facts = parseVerdict(task, turn.text)
  if (!facts) return { facts: {}, found: 0, usage: turn.usage, error: `no JSON verdict in: ${turn.text.slice(0, 200)}` }
  return { facts, found: Object.values(facts).filter(Boolean).length, usage: turn.usage }
}
