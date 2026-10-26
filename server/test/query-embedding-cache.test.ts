import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client.js'
import { vaults } from '../src/db/schema.js'
import { embedder, normalizeQueryText, QueryEmbeddingCache, type Embedder } from '../src/search/embeddings.js'
import { searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

// #684: a repeated search query must not run the embedder again. The key is
// the embedder id (model + embed-text version), the asking account and the
// normalised text: a hit is faster than an embed, so a cache shared across
// accounts would tell one account what another searched.

afterEach(() => {
  vi.restoreAllMocks()
})

/** An embedder that counts what it was asked to embed. */
function countingEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    embed(texts) {
      calls.push(texts)
      return Promise.resolve(texts.map((t) => [t.length, 1]))
    },
  }
}

describe('query-embedding cache (#684)', () => {
  it('the second identical query, after normalisation, makes zero embedder calls', async () => {
    const inner = countingEmbedder()
    const cache = new QueryEmbeddingCache(inner, () => 'model-a+text1', 10)

    const first = await cache.embed('acct-a', '  where is   the\tsync scheduler ')
    const second = await cache.embed('acct-a', 'where is the sync scheduler')

    expect(inner.calls).toEqual([['where is the sync scheduler']])
    expect(second).toEqual(first)
  })

  it('concurrent identical queries share one embed', async () => {
    const inner = countingEmbedder()
    const cache = new QueryEmbeddingCache(inner, () => 'model-a+text1', 10)
    await Promise.all([cache.embed('acct-a', 'same query'), cache.embed('acct-a', 'same query'), cache.embed('acct-a', 'same  query')])
    expect(inner.calls).toHaveLength(1)
  })

  it('a different embedder version misses', async () => {
    const inner = countingEmbedder()
    let embedderId = 'model-a+text1'
    const cache = new QueryEmbeddingCache(inner, () => embedderId, 10)

    await cache.embed('acct-a', 'graph edges')
    embedderId = 'model-a+text2'
    await cache.embed('acct-a', 'graph edges')

    expect(inner.calls).toHaveLength(2)
  })

  it('stays bounded: the least recently used entry is evicted', async () => {
    const inner = countingEmbedder()
    const cache = new QueryEmbeddingCache(inner, () => 'model-a+text1', 2)

    await cache.embed('acct-a', 'a')
    await cache.embed('acct-a', 'b')
    await cache.embed('acct-a', 'a') // a is now the most recent
    await cache.embed('acct-a', 'c') // evicts b
    expect(cache.size).toBe(2)
    expect(inner.calls).toHaveLength(3)

    await cache.embed('acct-a', 'a')
    expect(inner.calls).toHaveLength(3)
    await cache.embed('acct-a', 'b')
    expect(inner.calls).toHaveLength(4)
    expect(cache.size).toBe(2)
  })

  it('does not cache a failed embed', async () => {
    let fail = true
    let calls = 0
    const cache = new QueryEmbeddingCache(
      {
        embed(texts) {
          calls++
          return fail ? Promise.reject(new Error('worker died')) : Promise.resolve(texts.map(() => [1]))
        },
      },
      () => 'model-a+text1',
      10,
    )
    await expect(cache.embed('acct-a', 'q')).rejects.toThrow('worker died')
    fail = false
    await expect(cache.embed('acct-a', 'q')).resolves.toEqual([1])
    expect(calls).toBe(2)
    expect(cache.size).toBe(1)
  })

  it('normalises Unicode form and whitespace, nothing else', () => {
    expect(normalizeQueryText(' Cafe\u0301\n  au  lait ')).toBe('Caf\u00e9 au lait')
  })

  it('two accounts never share an entry', async () => {
    const inner = countingEmbedder()
    const cache = new QueryEmbeddingCache(inner, () => 'model-a+text1', 10)

    await cache.embed('acct-a', 'acquisition target')
    await cache.embed('acct-b', 'acquisition target')
    expect(inner.calls).toHaveLength(2)
    await cache.embed('acct-a', 'acquisition target')
    await cache.embed('acct-b', 'acquisition target')
    expect(inner.calls).toHaveLength(2)
  })

  it('search caches per asking account, and caches nothing without one', async () => {
    const a = await createActiveUser()
    const b = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'query-cache', ownerId: a.id }).returning()
    const resources = { vaultIds: [vault!.id], repositoryIds: [] }
    const embed = vi.spyOn(embedder, 'embed')

    await searchNotes(resources, 'where is the scheduler', undefined, {}, { accountId: a.id })
    await searchNotes(resources, 'where is the scheduler', undefined, {}, { accountId: a.id })
    expect(embed).toHaveBeenCalledTimes(1)
    await searchNotes(resources, 'where is the scheduler', undefined, {}, { accountId: b.id })
    expect(embed).toHaveBeenCalledTimes(2)
    await searchNotes(resources, 'where is the scheduler')
    await searchNotes(resources, 'where is the scheduler')
    expect(embed).toHaveBeenCalledTimes(4)
  })
})
