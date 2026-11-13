import { z } from 'zod'
import type { Budgeted, Section } from './response.js'

export const RESULT_TOOLS: Readonly<Record<string, true>> = { search: true, graph: true, find_symbols: true }
export const RESULT_GREP_ARG = z.string()
  .refine((pattern) => pattern.length > 0 && pattern.length <= 200, { error: 'grep is a literal text of 1 to 200 characters' })
  .optional().describe('Literal grep; smart case')

/** Same literal/smart-case convention as read targets, not the regex grep tool. */
function contains(value: unknown, pattern: string, fold: boolean): boolean {
  if (typeof value === 'string') return (fold ? value.toLowerCase() : value).includes(pattern)
  if (Array.isArray(value)) return value.some((item) => contains(item, pattern, fold))
  if (value !== null && typeof value === 'object') {
    for (const key in value) {
      if (Object.hasOwn(value, key) && contains(Reflect.get(value, key), pattern, fold)) return true
    }
  }
  return false
}

/** Filter the complete computed typed sections before the renderer pages them. */
export function resultHandle(answer: Budgeted, snapshot: string, pattern?: string): Budgeted {
  answer.snapshot = snapshot
  if (pattern === undefined) return answer
  const fold = pattern === pattern.toLowerCase()
  const coverage: Record<string, { scanned: number; matched: number; more: boolean }> = {}
  const capped = Array.isArray(answer.head.cappedGroups) && answer.head.cappedGroups.length > 0
  let incomplete = capped
  const sections = answer.sections.map((section): Section => {
    if (section.kind === 'text') {
      const matched = contains(section.text, pattern, fold)
      coverage[section.name] = { scanned: 1, matched: matched ? 1 : 0, more: section.withheld === true }
      incomplete ||= section.withheld === true
      return matched ? section : { ...section, text: '' }
    }
    const items = section.items.filter((item) => contains(item, pattern, fold))
    const more = capped || (section.kind === 'keyset' ? section.more === true : section.items.length > (section.limit ?? Infinity))
    coverage[section.name] = { scanned: section.items.length, matched: items.length, more }
    incomplete ||= more
    if (section.kind === 'keyset') {
      // A filtered handle replays the same bounded candidate set, never a
      // different SQL page. Its cursor is a ranking offset over the matches.
      const identities = new Map<unknown, string>()
      section.items.forEach((item, index) => identities.set(item, String(section.resume(item, index))))
      return { kind: 'ranked', name: section.name, items, limit: section.limit, ladder: section.ladder, id: (item) => identities.get(item)! }
    }
    return { ...section, items }
  })
  return {
    ...answer,
    snapshot,
    head: { ...answer.head, filter: { within: 'computed', sections: coverage } },
    sections,
    incomplete,
    narrow: [...(answer.narrow ?? []), 'grep filters the computed candidates only; raise limit or narrow the original query for more coverage'],
  }
}
