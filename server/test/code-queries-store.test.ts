// #470: the store queries over code edges: the symbol at a line, a name's definitions (several are
// an ambiguity, never a guess), references, callers, tests and the depth-grouped impact. A file of
// its own: on a base without code-queries.ts it fails on the import, which the fails-before job
// does not count (mcp-code-queries.test.ts is the case that fails on an assertion).
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { codeSites, findDefinitions, impact, SITE_KINDS, symbolAt, IMPACT_LEVEL_ROWS, type Definition } from '../src/repositories/code-queries.js'
import { createActiveUser } from './helpers.js'
import { FIXTURE } from './code-queries-fixture.js'

let repositoryId: string

beforeAll(async () => {
  const owner = await createActiveUser()
  const [repo] = await db.insert(repositories).values({ name: 'code-queries', ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
  repositoryId = repo!.id
  await syncRepositoryFiles(
    repositoryId,
    Object.entries(FIXTURE).map(([path, content]) => ({ path, content })),
    Object.keys(FIXTURE),
  )
  await flushExtraction()
}, 60_000)

const one = async (name: string, path?: string): Promise<Definition> => {
  const found = await findDefinitions(repositoryId, { name, path })
  expect(found, `${name} names one definition`).toHaveLength(1)
  return found[0]!
}
const shown = (sites: Array<{ path: string; line: number; symbol: string | null; kind: string; confidence: string }>) =>
  sites.map((s) => `${s.path}:${s.line} ${s.symbol ?? '-'} ${s.kind} ${s.confidence}`)

describe('definitions (#470)', () => {
  it('a name that is defined twice lists both, an inner path or a file picks one', async () => {
    const both = await findDefinitions(repositoryId, { name: 'parse' })
    expect(both.map((d) => `${d.path}:${d.line} ${d.symbol} ${d.kind}`)).toEqual(['src/other.ts:1 parse function', 'src/store.ts:14 parse function'])
    expect((await findDefinitions(repositoryId, { name: 'parse', path: 'src/store.ts' })).map((d) => d.path)).toEqual(['src/store.ts'])
    expect((await findDefinitions(repositoryId, { name: 'save' })).map((d) => d.symbol)).toEqual(['Store.save'])
    expect((await findDefinitions(repositoryId, { name: 'Store.save' })).map((d) => d.symbol)).toEqual(['Store.save'])
    expect(await findDefinitions(repositoryId, { name: 'Store.save', kind: 'function' })).toEqual([])
    expect(await findDefinitions(repositoryId, { name: 'nothing' })).toEqual([])
  })

  it('a symbol id (blocks.id or block_id) names its definition alone', async () => {
    const [first] = await findDefinitions(repositoryId, { name: 'parse', path: 'src/other.ts' })
    expect((await findDefinitions(repositoryId, { id: first!.id })).map((d) => d.path)).toEqual(['src/other.ts'])
    expect((await findDefinitions(repositoryId, { id: first!.blockIds[0] })).map((d) => d.path)).toEqual(['src/other.ts'])
    expect(await findDefinitions(repositoryId, { id: 'not-an-id' })).toEqual([])
  })
})

describe('symbol_at (#470)', () => {
  it('names the innermost symbol around a line and the edges on it', async () => {
    const at = await symbolAt(repositoryId, 'src/store.ts', 3, { limit: 10, offset: 0 })
    expect(at?.symbol).toMatchObject({ symbol: 'Store.save', kind: 'method', parent: 'Store', line: 2, endLine: 4, path: 'src/store.ts' })
    expect(at?.sites).toEqual([{ kind: 'call', confidence: 'resolved', name: 'normalize', target: { path: 'src/store.ts', symbol: 'normalize', line: 10 } }])
    expect((await symbolAt(repositoryId, 'src/store.ts', 1, { limit: 10, offset: 0 }))?.symbol?.symbol).toBe('Store')
  })

  it('answers no symbol between symbols, and null for a file that is not there', async () => {
    expect((await symbolAt(repositoryId, 'src/store.ts', 9, { limit: 10, offset: 0 }))?.symbol).toBeNull()
    expect((await symbolAt(repositoryId, 'src/store.ts', 999, { limit: 10, offset: 0 }))?.symbol).toBeNull()
    expect(await symbolAt(repositoryId, 'src/missing.ts', 1, { limit: 10, offset: 0 })).toBeNull()
  })
})

describe('references, callers and tests (#470)', () => {
  it('callers of a resolved function: resolved rows first, with the enclosing symbol and context', async () => {
    const sites = await codeSites(repositoryId, await one('normalize'), SITE_KINDS.callers, { limit: 20, offset: 0 })
    expect(shown(sites)).toEqual([
      'src/handler.ts:6 handle call resolved',
      'src/store.test.ts:4 - call resolved',
      'src/store.ts:3 Store.save call resolved',
    ])
    expect(sites[0]!.context).toBe('return normalize(x)')
  })

  it('references add the imports; the test edge is its own question', async () => {
    const target = await one('normalize')
    expect(shown(await codeSites(repositoryId, target, SITE_KINDS.references, { limit: 20, offset: 0 }))).toEqual([
      'src/handler.ts:1 - import resolved',
      'src/handler.ts:6 handle call resolved',
      'src/store.test.ts:1 - import resolved',
      'src/store.test.ts:4 - call resolved',
      'src/store.ts:3 Store.save call resolved',
    ])
    expect(shown(await codeSites(repositoryId, target, SITE_KINDS.tests, { limit: 20, offset: 0 }))).toEqual(['src/store.test.ts:4 - test resolved'])
  })

  it('a method is found through this, its class and a receiver of unknown type', async () => {
    const sites = await codeSites(repositoryId, await one('Store.save'), SITE_KINDS.callers, { limit: 20, offset: 0 })
    expect(shown(sites)).toEqual(['src/store.ts:6 Store.load call resolved', 'src/handler.ts:5 handle call textual'])
  })

  it('Python: the cross-file calls are textual, the same-file one is resolved', async () => {
    const sites = await codeSites(repositoryId, await one('helper'), SITE_KINDS.callers, { limit: 20, offset: 0 })
    expect(shown(sites)).toEqual(['lib/util.py:6 run call resolved', 'lib/main.py:5 main call textual', 'tests/test_util.py:5 test_helper call textual'])
    expect(shown(await codeSites(repositoryId, await one('helper'), SITE_KINDS.tests, { limit: 20, offset: 0 }))).toEqual(['tests/test_util.py:5 test_helper test textual'])
  })

  it('an ambiguous name’s sites need its definition: each file’s own callers, and not the package import’s', async () => {
    const other = await codeSites(repositoryId, await one('parse', 'src/other.ts'), SITE_KINDS.callers, { limit: 20, offset: 0 })
    expect(shown(other)).toEqual(['src/reader.ts:4 read call resolved'])
    // `import { parse } from 'yaml'` in src/yaml-user.ts: a textual row for a name the file gets from outside, left out.
    const store = await codeSites(repositoryId, await one('parse', 'src/store.ts'), SITE_KINDS.callers, { limit: 20, offset: 0 })
    expect(shown(store)).toEqual([])
  })

  it('pages by offset in one total order', async () => {
    const target = await one('normalize')
    const all = await codeSites(repositoryId, target, SITE_KINDS.references, { limit: 50, offset: 0 })
    const paged = [
      ...(await codeSites(repositoryId, target, SITE_KINDS.references, { limit: 2, offset: 0 })),
      ...(await codeSites(repositoryId, target, SITE_KINDS.references, { limit: 2, offset: 2 })),
      ...(await codeSites(repositoryId, target, SITE_KINDS.references, { limit: 2, offset: 4 })),
    ]
    expect(paged).toEqual(all)
  })
})

describe('impact (#470)', () => {
  it('groups the dependents by depth: each symbol on its shortest level, the confidence of its weakest hop', async () => {
    const levels = await impact(repositoryId, await one('normalize'), 3)
    expect(levels.map((l) => shown(l.sites))).toEqual([
      ['src/handler.ts:6 handle call resolved', 'src/store.test.ts:4 - call resolved', 'src/store.ts:3 Store.save call resolved'],
      ['src/handler.ts:10 route call resolved', 'src/store.ts:6 Store.load call resolved'],
      ['src/handler.ts:14 top call resolved'],
    ])
    expect(levels.map((l) => [l.total, l.capped])).toEqual([[3, false], [2, false], [1, false]])
    expect(levels[0]!.sites[0]).not.toHaveProperty('to')
    expect(levels[1]!.sites.map((s) => s.to)).toEqual(['src/handler.ts#handle', 'src/store.ts#Store.save'])
  })

  it('stops at the depth asked, and a textual hop makes the rest of its chain textual', async () => {
    expect((await impact(repositoryId, await one('normalize'), 1)).map((l) => l.sites.length)).toEqual([3])
    const levels = await impact(repositoryId, await one('Store.save'), 2)
    expect(levels.map((l) => shown(l.sites))).toEqual([
      ['src/store.ts:6 Store.load call resolved', 'src/handler.ts:5 handle call textual'],
      ['src/handler.ts:10 route call textual'],
    ])
  })

  it('a cycle does not come back, and the depth is capped at 3', async () => {
    // ping calls pong, which calls ping back: the second level would list ping, the symbol asked about.
    expect((await impact(repositoryId, await one('ping'), 3)).map((l) => shown(l.sites))).toEqual([['src/cycle.ts:6 pong call resolved']])
    expect(await impact(repositoryId, await one('top'), 9)).toEqual([])
    expect((await impact(repositoryId, await one('normalize'), 9)).length).toBeLessThanOrEqual(3)
    expect(IMPACT_LEVEL_ROWS).toBeGreaterThan(0)
  })
})
