// #469: the store reads of code edges, the row #470 shows (`path:line`, the enclosing symbol, one line of
// context, the confidence and the target) and an ambiguous name's candidates. A file of its own: on a base
// without code-edges.ts it fails on the import, which the fails-before job does not count (code-edges.test.ts does).
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { listCodeEdges, symbolCandidates } from '../src/repositories/code-edges.js'
import { createActiveUser } from './helpers.js'

const FILES: Record<string, string> = {
  'src/a.ts': 'export function parse(s: string) {\n  return s\n}\n',
  'src/b.ts': 'export function parse(s: string) {\n  return s\n}\n\nexport function load() {\n  return 1\n}\n',
  'src/main.ts': "import { load } from './b'\n\nexport function main() {\n  return parse(String(load()))\n}\n",
}

describe('code edge reads (#469)', () => {
  it('lists edges by file and by name, and an ambiguous name’s candidates', async () => {
    const owner = await createActiveUser()
    const [repo] = await db.insert(repositories).values({ name: 'edges-store', ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
    await syncRepositoryFiles(
      repo!.id,
      Object.entries(FILES).map(([path, content]) => ({ path, content })),
      Object.keys(FILES),
    )
    await flushExtraction()

    const rows = await listCodeEdges(repo!.id, { path: 'src/main.ts' })
    expect(rows.map((r) => [r.line, r.kind, r.name, r.confidence, r.target && `${r.target.path}:${r.target.line} ${r.target.symbol}`, r.symbol])).toEqual([
      [1, 'import', 'load', 'resolved', 'src/b.ts:5 load', null],
      [4, 'call', 'parse', 'textual', null, 'main'],
      [4, 'call', 'String', 'textual', null, 'main'],
      [4, 'call', 'load', 'resolved', 'src/b.ts:5 load', 'main'],
    ])
    expect(rows[1]!.context).toBe('return parse(String(load()))')

    expect((await listCodeEdges(repo!.id, { name: 'load' })).map((r) => `${r.path}:${r.line} ${r.kind}`)).toEqual(['src/main.ts:1 import', 'src/main.ts:4 call'])
    expect(await symbolCandidates(repo!.id, 'parse')).toEqual([
      { path: 'src/a.ts', symbol: 'parse', kind: 'function', line: 1 },
      { path: 'src/b.ts', symbol: 'parse', kind: 'function', line: 1 },
    ])
  })
})
