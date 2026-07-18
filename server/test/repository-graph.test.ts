import { describe, expect, it } from 'vitest'
import { buildGraph } from '../src/graph/assemble.js'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'
import { buildApp } from '../src/app.js'

async function makeRepo() {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'graph-test', ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  return repo!
}

describe('buildGraph over repositories', () => {
  it('includes code nodes, extracted import edges, and structural directory/language edges', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(
      repo.id,
      [
        { path: 'src/a.ts', content: 'export function helper() { return 1 }' },
        { path: 'src/index.ts', content: "import { helper } from './a'\nexport function main() { return helper() }" },
        { path: 'lib/other.py', content: 'def foo():\n    pass\n' },
      ],
      ['src/a.ts', 'src/index.ts', 'lib/other.py'],
    )
    await flushExtraction()

    const graph = await buildGraph({ vaultIds: [], repositoryIds: [repo.id] })
    expect(graph.nodes).toHaveLength(3)
    expect(graph.nodes.every((n) => n.resourceType === 'code')).toBe(true)

    const byPath = new Map(graph.nodes.map((n) => [n.path, n.id]))
    const hasEdge = (a: string, b: string, kind: string) =>
      graph.edges.some(
        (e) =>
          e.kind === kind &&
          ((e.source === byPath.get(a) && e.target === byPath.get(b)) ||
            (e.source === byPath.get(b) && e.target === byPath.get(a))),
      )
    expect(hasEdge('src/index.ts', 'src/a.ts', 'extracted')).toBe(true)
    expect(hasEdge('src/index.ts', 'src/a.ts', 'structural')).toBe(true) // same top-level dir
    expect(hasEdge('src/a.ts', 'lib/other.py', 'structural')).toBe(false) // different dir, different language
  })

  it('assigns Louvain communities across the unioned node set', async () => {
    const repo = await makeRepo()
    await syncRepositoryFiles(repo.id, [{ path: 'x.go', content: 'package main\nfunc Foo() {}\n' }], ['x.go'])
    await flushExtraction()
    const graph = await buildGraph({ vaultIds: [], repositoryIds: [repo.id] })
    expect(graph.nodes.every((n) => typeof n.community === 'number')).toBe(true)
  })

  it('a mixed resource set returns nodes from both vaults and repositories', async () => {
    const app = await buildApp()
    await app.ready()
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie },
        body: { name: 'mixed-graph-vault' },
      })
    ).json() as { id: string }
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/notes`,
      headers: { cookie },
      body: { type: 'docs', name: 'readme', body: 'hello' },
    })
    const repo = await makeRepo()
    await syncRepositoryFiles(repo.id, [{ path: 'y.ts', content: 'export const y = 1' }], ['y.ts'])
    await flushExtraction()

    const graph = await buildGraph({ vaultIds: [vault.id], repositoryIds: [repo.id] })
    expect(graph.nodes.some((n) => n.resourceType === 'note')).toBe(true)
    expect(graph.nodes.some((n) => n.resourceType === 'code')).toBe(true)
    await app.close()
  })

  it('produces a semantic edge between a note and a code file with similar content', async () => {
    const app = await buildApp()
    await app.ready()
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie },
        body: { name: 'semantic-graph-vault' },
      })
    ).json() as { id: string }
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/notes`,
      headers: { cookie },
      body: { type: 'docs', name: 'rocket', body: 'Rocket engine guidance software design.' },
    })
    const repo = await makeRepo()
    await syncRepositoryFiles(
      repo.id,
      [{ path: 'guidance.py', content: '# Rocket engine guidance software\ndef fly():\n    pass\n' }],
      ['guidance.py'],
    )
    await flushExtraction()

    const graph = await buildGraph({ vaultIds: [vault.id], repositoryIds: [repo.id] })
    const semantic = graph.edges.filter((e) => e.kind === 'semantic')
    expect(semantic.length).toBeGreaterThan(0)
    await app.close()
  })
})
