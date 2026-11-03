// #414: the hits of an MCP `search` answer leave out what the call or the path already says, so more of them fit the answer's token budget.
import { describe, expect, it } from 'vitest'
import { leanHit, leanHitKey } from '../src/mcp/search-hit.js'
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

describe('a lean search hit (#414)', () => {
  it('leaves out the container of a one-container search, keeps it across several', () => {
    expect(leanHit(hit({}), true)).not.toHaveProperty('containerId')
    expect(leanHit(hit({}), false).containerId).toBe('89767606-c692-4ec0-a91d-140c4c45f0c6')
  })

  it("keeps a symbol's id (find_symbols takes it) and drops a note's or file's (reads take the path)", () => {
    expect(leanHit(hit({ resourceType: 'symbol', type: 'function', language: undefined }), true).id).toBe('4b6940cf-c84e-4e42-9840-40ecd2749c50')
    expect(leanHit(hit({}), true)).not.toHaveProperty('id')
    expect(leanHit(hit({ resourceType: 'note', type: 'docs', language: undefined }), true)).not.toHaveProperty('id')
  })

  it("drops a code hit's type only when it is its language; a note's type stays", () => {
    expect(leanHit(hit({}), true)).not.toHaveProperty('type')
    expect(leanHit(hit({ type: 'other' }), true).type).toBe('other')
    expect(leanHit(hit({ resourceType: 'note', type: 'docs', language: undefined }), true).type).toBe('docs')
  })

  it('rounds the score to five decimals and keeps the order of scores it rounds', () => {
    expect(leanHit(hit({ score: 0.01639344262295082 }), true).score).toBe(0.01639)
    const a = leanHit(hit({ score: 1 / 61 }), true).score
    const b = leanHit(hit({ score: 1 / 62 }), true).score
    expect(a).toBeGreaterThan(b)
  })

  it('names a hit for a cursor by container and path (note, file) or by symbol id, so lean hits stay distinguishable', () => {
    const a = leanHit(hit({ containerId: 'c1' }), false)
    const b = leanHit(hit({ containerId: 'c2' }), false)
    expect(leanHitKey(a)).not.toBe(leanHitKey(b))
    const s1 = leanHit(hit({ resourceType: 'symbol', id: 's1', type: 'function' }), true)
    const s2 = leanHit(hit({ resourceType: 'symbol', id: 's2', type: 'function' }), true)
    expect(leanHitKey(s1)).not.toBe(leanHitKey(s2))
  })
})
