// Deterministic grading of an agent's answer against a task's key facts and
// false claims (benchmarks/agent-trial/tasks.json). No language model: the
// same answer always gets the same grade. Node-compatible.
import type { FalseClaim, Task } from './tasks.ts'

/**
 * A sentence carrying one of these words repeats a claim in order to deny or
 * report it ("the README says BM25, but ..."), so it is not counted as making
 * the claim. A claim whose own wording is negative sets `unless` instead.
 */
export const DEFAULT_UNLESS =
  "\\b(no|not|never|none|without|cannot|wrong|incorrect|false|inaccurate|fabricated|refuted|claims?|claimed|says|said|states|stated|asserts|outdated|stale|drift|myth|contrary|contradicts?|rather than|instead of)\\b|n't\\b"

export interface FactGrade {
  id: string
  found: boolean
}

export interface FalseClaimHit {
  id: string
  sentence: string
}

export interface Grade {
  facts: FactGrade[]
  found: number
  total: number
  /** found / total, rounded to 4 places. */
  recall: number
  falseClaims: FalseClaimHit[]
}

/**
 * Sentences and table rows of an answer: split at line breaks and at
 * sentence ends (`.`, `!`, `?` followed by whitespace, so `store.ts:106`
 * stays whole).
 */
export function sentences(answer: string): string[] {
  return answer
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The first sentence of the answer that makes the claim, or null. */
export function claimSentence(claim: Pick<FalseClaim, 'patterns' | 'unless'>, answer: string): string | null {
  const patterns = claim.patterns.map((p) => new RegExp(p, 'i'))
  const unless = new RegExp(claim.unless ?? DEFAULT_UNLESS, 'i')
  return sentences(answer).find((s) => patterns.every((p) => p.test(s)) && !unless.test(s)) ?? null
}

export function gradeAnswer(task: Task, answer: string): Grade {
  const facts = task.facts.map((f) => ({ id: f.id, found: f.patterns.every((p) => new RegExp(p, 'i').test(answer)) }))
  const found = facts.filter((f) => f.found).length
  const falseClaims: FalseClaimHit[] = []
  for (const c of task.falseClaims) {
    const sentence = claimSentence(c, answer)
    if (sentence !== null) falseClaims.push({ id: c.id, sentence: sentence.slice(0, 500) })
  }
  return {
    facts,
    found,
    total: facts.length,
    recall: facts.length === 0 ? 0 : Math.round((found / facts.length) * 10_000) / 10_000,
    falseClaims,
  }
}
