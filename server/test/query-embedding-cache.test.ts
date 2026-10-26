import { describe, expect, it } from 'vitest'
import { normalizeQueryText, QueryEmbeddingCache, type Embedder } from '../src/search/embeddings.js'

// #684: a repeated search query must not run the embedder again. The key is
// the embedder id (model + embed-text version) and the normalised text.

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

    const first = await cache.embed('  where is   the\tsync scheduler ')
    const second = await cache.embed('where is the sync scheduler')

    expect(inner.calls).toEqual([['where is the sync scheduler']])
    expect(second).toEqual(first)
  })

  it('concurrent identical queries share one embed', async () => {
    const inner = countingEmbedder()
    const cache = new QueryEmbeddingCache(inner, () => 'model-a+text1', 10)
    await Promise.all([cache.embed('same query'), cache.embed('same query'), cache.embed('same  query')])
    expect(inner.calls).toHaveLength(1)
  })

  it('a different embedder version misses', async () => {
    const inner = countingEmbedder()
    let embedderId = 'model-a+text1'
    const cache = new QueryEmbeddingCache(inner, () => embedderId, 10)

    await cache.embed('graph edges')
    embedderId = 'model-a+text2'
    await cache.embed('graph edges')

    expect(inner.calls).toHaveLength(2)
  })

  it('stays bounded: the least recently used entry is evicted', async () => {
    const inner = countingEmbedder()
    const cache = new QueryEmbeddingCache(inner, () => 'model-a+text1', 2)

    await cache.embed('a')
    await cache.embed('b')
    await cache.embed('a') // a is now the most recent
    await cache.embed('c') // evicts b
    expect(cache.size).toBe(2)
    expect(inner.calls).toHaveLength(3)

    await cache.embed('a')
    expect(inner.calls).toHaveLength(3)
    await cache.embed('b')
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
    await expect(cache.embed('q')).rejects.toThrow('worker died')
    fail = false
    await expect(cache.embed('q')).resolves.toEqual([1])
    expect(calls).toBe(2)
    expect(cache.size).toBe(1)
  })

  it('normalises Unicode form and whitespace, nothing else', () => {
    expect(normalizeQueryText(' Cafe\u0301\n  au  lait ')).toBe('Caf\u00e9 au lait')
  })
})
