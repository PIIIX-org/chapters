import { SITE_KINDS, type codeSites, type CodeSite, type Target } from '../repositories/code-queries.js'

export type StructuralQuestion = { kind: 'callers' | 'references' | 'tests' | 'imports' | 'definition'; term: string }

/** Deliberately anchored: prose mentioning a graph operation is still conceptual. */
export function classifyStructural(query: string): StructuralQuestion | null {
  const match = /^(who calls|callers of|what imports|references to|tests for|defined in)\s+`?([\p{L}\p{N}_$.:/-]{1,200})`?[?.!]?$/iu.exec(query.trim())
  if (!match) return null
  const kinds = { 'who calls': 'callers', 'callers of': 'callers', 'what imports': 'imports', 'references to': 'references', 'tests for': 'tests', 'defined in': 'definition' } as const
  return { kind: kinds[match[1]!.toLowerCase() as keyof typeof kinds], term: match[2]!.replace(/[?.!]$/, '').replace(/^\.?\//, '') }
}

export interface StructuralTarget { repositoryId: string; target: Target }
export interface StructuralSite extends CodeSite { repositoryId: string }

/** Globally bounded, including the sentinel; never one query for every accessible repository. */
export async function dispatchStructural(
  question: StructuralQuestion,
  targets: readonly StructuralTarget[],
  limit: number,
  queries: { codeSites: typeof codeSites },
): Promise<{ resolved: StructuralSite[]; textual: StructuralSite[]; partial: boolean }> {
  const sites: StructuralSite[] = []
  for (const { repositoryId, target } of targets) {
    if (sites.length > limit) break
    const kinds = question.kind === 'imports' ? ['import'] as const : question.kind === 'definition' ? [] : SITE_KINDS[question.kind]
    const rows = await queries.codeSites(repositoryId, target, kinds, { limit: limit + 1 - sites.length, offset: 0 }, question.kind !== 'callers')
    sites.push(...rows.map((row) => ({ ...row, repositoryId })))
  }
  sites.sort((a, b) => Number(b.confidence === 'resolved') - Number(a.confidence === 'resolved') || compare(a.path, b.path) || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) || a.col - b.col || compare(a.kind, b.kind) || compare(a.repositoryId, b.repositoryId))
  return { resolved: sites.filter((s) => s.confidence === 'resolved'), textual: sites.filter((s) => s.confidence === 'textual'), partial: sites.length > limit }
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
