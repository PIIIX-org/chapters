// Question suites of the premise benchmark: benchmarks/questions/<suite>.json.
// One suite = one repository pinned to one commit, plus questions with
// file-level relevance judgments, line-level gold evidence and the grep
// keywords of the baseline policy.
import { createHash } from 'node:crypto'
import type { Judgments, LineRange } from './metrics.ts'

export interface Question {
  id: string
  category: string
  /** Asked verbatim (Elara policy: the search query). */
  question: string
  /**
   * Baseline grep patterns (ripgrep regex, case-insensitive, OR-ed). Taken
   * from the question's own words or identifiers, never from the answer.
   */
  keywords: string[]
  /** Repository files that answer the question (graded 1). */
  relevant: string[]
  /** Evidence as `path:line` or `path:start-end` (all paths in `relevant`). */
  gold: string[]
}

export interface Suite {
  suite: string
  description: string
  repo: { url: string; commit: string }
  /** Where the questions and answers come from. */
  source: string
  questions: Question[]
}

const GOLD = /^(.+):(\d+)(?:-(\d+))?$/

export function parseGold(ref: string): LineRange {
  const m = GOLD.exec(ref)
  if (!m) throw new Error(`gold "${ref}" is not path:line or path:start-end`)
  const start = Number(m[2])
  const end = m[3] === undefined ? start : Number(m[3])
  if (start < 1 || end < start) throw new Error(`gold "${ref}" has an empty range`)
  return { path: m[1]!, start, end }
}

export function judgments(q: Question): Judgments {
  return new Map(q.relevant.map((path) => [path, 1]))
}

/** Every structural problem of a suite (empty = valid). Does not look at the repository. */
export function validateSuite(s: Suite): string[] {
  const errors: string[] = []
  if (!/^[a-z0-9-]+$/.test(s.suite)) errors.push(`suite name "${s.suite}" must be [a-z0-9-]+`)
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(s.repo.url)) errors.push(`repo url "${s.repo.url}" must be a public https GitHub URL`)
  if (!/^[0-9a-f]{40}$/.test(s.repo.commit)) errors.push(`repo commit "${s.repo.commit}" must be a full 40-hex sha`)
  if (s.questions.length === 0) errors.push('no questions')
  const ids = new Set<string>()
  for (const q of s.questions) {
    const where = `${s.suite}/${q.id}`
    if (ids.has(q.id)) errors.push(`${where}: duplicate id`)
    ids.add(q.id)
    if (!q.question.trim()) errors.push(`${where}: empty question`)
    if (q.keywords.length === 0) errors.push(`${where}: no grep keywords`)
    for (const k of q.keywords) {
      try {
        new RegExp(k, 'i')
      } catch {
        errors.push(`${where}: keyword /${k}/ is not a valid regex`)
      }
    }
    if (q.relevant.length === 0) errors.push(`${where}: no relevant file`)
    if (q.gold.length === 0) errors.push(`${where}: no gold evidence`)
    for (const g of q.gold) {
      try {
        const r = parseGold(g)
        if (!q.relevant.includes(r.path)) errors.push(`${where}: gold ${g} is in a file missing from relevant`)
      } catch (err) {
        errors.push(`${where}: ${(err as Error).message}`)
      }
    }
  }
  return errors
}

/**
 * Identity of what a suite measures: the suite file plus the policy
 * configuration. A baseline only compares with a run of the same fingerprint.
 */
export function fingerprint(s: Suite, config: unknown): string {
  return createHash('sha256').update(JSON.stringify({ suite: s, config })).digest('hex').slice(0, 16)
}
