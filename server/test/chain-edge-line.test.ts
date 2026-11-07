// #558: the line `summarize_concept_chain` prints for each edge of the path (the prompt itself: mcp-prompts.test.ts).
import { describe, expect, it } from 'vitest'
import { chainEdgeLine } from '../src/mcp/prompts.js'

describe('the chain prompt\'s edge line (#558)', () => {
  const row = { from: { path: 'a/x' }, to: { path: 'b/y' }, directed: true, kind: 'extracted', relation: 'link', confidence: 'resolved', evidence: 'a/x#L4' } as const
  it('names both ends, the direction, why, how sure and where it is written', () => {
    expect(chainEdgeLine(row)).toBe('  - a/x -> b/y (link, extracted, resolved, a/x#L4)')
    expect(chainEdgeLine({ ...row, directed: false, kind: 'structural', relation: 'same_type', evidence: 'type:a' })).toBe('  - a/x -- b/y (same_type, structural, resolved, type:a)')
  })
  it('has no trailing location when the edge is written nowhere (a similarity)', () => {
    expect(chainEdgeLine({ ...row, directed: false, kind: 'semantic', relation: 'similar', confidence: 0.5, evidence: null })).toBe('  - a/x -- b/y (similar, semantic, 0.5)')
  })
})
