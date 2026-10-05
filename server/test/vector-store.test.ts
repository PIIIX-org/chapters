import { describe, expect, it } from 'vitest'
import { MemoryVectorStore } from '../src/search/vector/memory-store.js'

describe('MemoryVectorStore', () => {
  it('handles note upsert, query, and delete', async () => {
    const store = new MemoryVectorStore()
    await store.init()

    const vecA = [1, 0, 0]
    const vecB = [0.9, 0.1, 0]
    const vecC = [0, 1, 0]

    await store.upsertNote('n1', vecA, { vaultId: 'v1', path: 'notes/a', type: 'note' }, 'Alpha content')
    await store.upsertNote('n2', vecB, { vaultId: 'v1', path: 'notes/b', type: 'note' }, 'Beta content')
    await store.upsertNote('n3', vecC, { vaultId: 'v1', path: 'notes/c', type: 'note' }, 'Gamma content')

    const res = await store.queryNotes(vecA, ['v1'], 2)
    expect(res).toHaveLength(2)
    expect(res[0]?.id).toBe('n1')
    expect(res[0]?.score).toBeCloseTo(1, 5)
    expect(res[1]?.id).toBe('n2')

    await store.deleteNote('n1')
    const resAfter = await store.queryNotes(vecA, ['v1'], 2)
    expect(resAfter[0]?.id).toBe('n2')
  })

  it('handles code file and symbol search', async () => {
    const store = new MemoryVectorStore()
    await store.init()

    const vecF = [0.5, 0.5, 0]
    await store.upsertFile('f1', vecF, { repositoryId: 'r1', path: 'src/main.ts', language: 'typescript' }, 'export function main() {}')

    const files = await store.queryFiles(vecF, ['r1'], 1)
    expect(files).toHaveLength(1)
    expect(files[0]?.id).toBe('f1')

    await store.upsertSymbols([
      {
        id: 's1',
        embedding: [0.5, 0.5, 0],
        meta: {
          fileId: 'f1',
          repositoryId: 'r1',
          name: 'main',
          kind: 'function',
          path: 'src/main.ts',
          startLine: 1,
          endLine: 1,
        },
        snippet: 'export function main()',
      },
    ])

    const symbols = await store.querySymbols(vecF, ['r1'], 1)
    expect(symbols).toHaveLength(1)
    expect(symbols[0]?.name).toBe('main')
  })

  it('computes cross-type knn neighbors', async () => {
    const store = new MemoryVectorStore()
    await store.init()

    await store.upsertNote('n1', [1, 0, 0], { vaultId: 'v1', path: 'n1', type: 'note' })
    await store.upsertFile('f1', [0.99, 0.01, 0], { repositoryId: 'r1', path: 'f1', language: 'ts' })

    const knn = await store.knn([1, 0, 0], 'note', 'n1', 5)
    expect(knn).toHaveLength(1)
    expect(knn[0]?.type).toBe('code')
    expect(knn[0]?.id).toBe('f1')
    expect(knn[0]?.similarity).toBeGreaterThan(0.9)
  })
})
