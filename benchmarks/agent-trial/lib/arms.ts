// The two arms of the trial: what each agent is told, and the scripted
// model's tool-call plan for a dry run. Node-compatible.
import type { ToolResultPart } from './model.ts'
import type { Task } from './tasks.ts'

export const ARMS = ['elara', 'local'] as const
export type Arm = (typeof ARMS)[number]

export function parseArms(raw: string): Arm[] {
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (wanted.length === 0) return [...ARMS]
  const unknown = wanted.filter((a) => !ARMS.includes(a as Arm))
  if (unknown.length > 0) throw new Error(`unknown arms ${unknown.join(', ')}; have ${ARMS.join(', ')}`)
  return ARMS.filter((a) => wanted.includes(a))
}

export function systemPrompt(arm: Arm, opts: { maxToolCalls: number; repositoryId?: string }): string {
  const access =
    arm === 'elara'
      ? [
          'Your only access to the code is through the tools provided, which call Elara, a knowledge server that has indexed the repository.',
          `The connection is pinned to that repository (repositoryId ${opts.repositoryId ?? 'unknown'}); tools that take a repositoryId accept it or default to it.`,
        ]
      : ['Your only access to the code is through the tools provided, which list, search and read a checkout of the repository.']
  return [
    'You are a software engineer answering a question about the source code of the `chapters` repository (Elara, a self-hosted second brain for AI agents).',
    ...access,
    'You have no other knowledge of this repository: do not answer from memory.',
    'Give file:line evidence for every claim. Mark anything you could not verify in the code with [INFERENCE].',
    `You may make at most ${opts.maxToolCalls} tool calls. When you have enough evidence, reply with your final answer and no tool call.`,
  ].join('\n')
}

/**
 * The scripted model's plan for a dry run: three calls that exercise each
 * arm's tool mapping end to end (status or listing, a search, a read of the
 * first fact's evidence file). Deterministic; not an agent.
 */
export function dryRunPlan(task: Task, arm: Arm): Array<{ name: string; args: Record<string, unknown> }> {
  const e = task.facts[0]!.evidence[0]!
  if (arm === 'elara') {
    return [
      { name: 'repository_status', args: {} },
      { name: 'search', args: { query: task.title, limit: 5 } },
      { name: 'read_file', args: { path: e.path } },
    ]
  }
  const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : ''
  const start = Number(e.lines.split('-')[0])
  return [
    { name: 'list_files', args: { pattern: dir ? `${dir}/**` : '*', limit: 50 } },
    { name: 'grep', args: { pattern: e.contains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), path: dir, max_results: 20 } },
    { name: 'read_file', args: { path: e.path, offset: Math.max(1, start - 5), limit: 40 } },
  ]
}

/** The scripted model's final answer: what it called and got back. Not graded as an agent answer. */
export function dryRunAnswer(results: ToolResultPart[]): string {
  return [
    'DRY RUN: scripted model, no language model. Tool results received:',
    ...results.map((r) => `- ${r.name}: ${r.isError ? 'error' : 'ok'}, ${r.text.length} characters: ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`),
  ].join('\n')
}
