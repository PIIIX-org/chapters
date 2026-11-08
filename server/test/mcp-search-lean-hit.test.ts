// #414: the hits of an MCP `search` answer leave out what the call or the hit already says, so more of them fit the answer's token budget.
import { describe, expect, it } from 'vitest'
import { leanHit } from '../src/mcp/search-hit.js'
import type { SearchResult } from '../src/search/search.js'

const hit = (over: Partial<SearchResult>): SearchResult => ({
  resourceType: 'code',
  id: '4b6940cf-c84e-4e42-9840-40ecd2749c50',
  containerId: '89767606-c692-4ec0-a91d-140c4c45f0c6',
  path: 'src/gateway.ts',
  type: 'typescript',
  language: 'typescript',
  snippet: 'x',
  score: 0.01639344262295082,
  channel: 'keyword',
  updated: '2026-11-03',
  ...over,
})
const symbol = (over: Partial<SearchResult> = {}): SearchResult =>
  hit({ resourceType: 'symbol', type: 'function', language: undefined, symbolName: 'rotate', symbolKind: 'function', heading: 'rotate', ...over })

describe('a lean search hit (#414)', () => {
  it('leaves out the container of a call that named its container, keeps it across several', () => {
    expect(leanHit(hit({}), true)).not.toHaveProperty('containerId')
    expect(leanHit(hit({}), false).containerId).toBe('89767606-c692-4ec0-a91d-140c4c45f0c6')
  })

  it('leaves out the block id and the channel (#1122): reads go by lines, REST keeps both', () => {
    const lean = JSON.parse(JSON.stringify(leanHit(hit({ block: 'b_abcdefghijkl', heading: 'x' }), true))) as Record<string, unknown>
    expect(Object.keys(lean)).not.toContain('block')
    expect(Object.keys(lean)).not.toContain('channel')
    expect(lean.heading).toBe('x')
  })

  it('saves what the two fields weigh: about 45 characters of a located hit, measured', () => {
    const located = hit({ block: 'b_abcdefghijkl', channel: 'both', startLine: 10, endLine: 40, tokens: 120, heading: 'rotate', snippet: 'x' })
    const withFields = JSON.stringify({ ...leanHit(located, true), block: located.block, channel: located.channel }).length
    const lean = JSON.stringify(leanHit(located, true)).length
    expect(withFields - lean).toBeGreaterThanOrEqual(40)
    console.info(`#1122 located hit: ${withFields} -> ${lean} characters (${withFields - lean} fewer)`)
  })

  it("keeps the hit's id: the usage report reads hits by it (#678)", () => {
    for (const h of [hit({}), symbol(), hit({ resourceType: 'note', type: 'docs', language: undefined })]) expect(leanHit(h, true).id).toBe('4b6940cf-c84e-4e42-9840-40ecd2749c50')
  })

  it("drops `type` only where it repeats the code hit's language or the symbol hit's kind; a note's type stays", () => {
    expect(leanHit(hit({}), true)).not.toHaveProperty('type')
    expect(leanHit(hit({ type: 'other' }), true).type).toBe('other')
    expect(leanHit(symbol(), true)).not.toHaveProperty('type')
    expect(leanHit(symbol({ type: 'other' }), true).type).toBe('other')
    expect(leanHit(hit({ resourceType: 'note', type: 'docs', language: undefined }), true).type).toBe('docs')
  })

  it("drops a symbol hit's `heading` (its name path is `symbolName` and `symbolParent`) and keeps a file hit's and a note hit's", () => {
    expect(leanHit(symbol(), true)).not.toHaveProperty('heading')
    expect(leanHit(hit({ heading: 'rotate' }), true).heading).toBe('rotate')
    expect(leanHit(hit({ resourceType: 'note', type: 'docs', language: undefined, heading: 'Guide > Setup' }), true).heading).toBe('Guide > Setup')
  })

  it('rounds the score to five decimals and keeps the order of scores it rounds', () => {
    expect(leanHit(hit({ score: 0.01639344262295082 }), true).score).toBe(0.01639)
    expect(leanHit(hit({ score: 1 / 61 }), true).score).toBeGreaterThan(leanHit(hit({ score: 1 / 62 }), true).score)
  })
})
