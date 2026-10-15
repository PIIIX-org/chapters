import { afterEach, describe, expect, it, vi } from 'vitest'

// The real model is never loaded: the pipeline records what it was asked to run.
const runs = vi.hoisted((): string[][] => [])
vi.mock('@huggingface/transformers', () => ({
  pipeline: () =>
    Promise.resolve((texts: string[]) => {
      runs.push(texts)
      return Promise.resolve({ tolist: () => texts.map((t) => [t.length]) })
    }),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  runs.length = 0
})

describe('local embedder', () => {
  it('runs the model on small batches of bounded texts, returning vectors in input order', async () => {
    vi.stubEnv('EMBEDDINGS', 'local')
    // Dynamic: config reads EMBEDDINGS when the module graph loads, so the
    // embedder module must be evaluated after the stub.
    vi.resetModules()
    const { embedder } = await import('../src/search/embeddings.js')

    // One extraction call for a big file: the file text plus many symbol texts.
    // Run as one batch, the pipeline pads all of them to 512 tokens at once —
    // measured ~32 MB of activations per text (30.7 GB for 948 texts).
    const texts = [`src/bundle.mjs\n${'x'.repeat(742_000)}`, ...Array.from({ length: 40 }, (_, i) => `function f${i}`)]
    const vectors = await embedder.embed(texts)

    expect(runs.length).toBeGreaterThan(1)
    expect(Math.max(...runs.map((r) => r.length))).toBeLessThanOrEqual(8)
    expect(Math.max(...runs.flat().map((t) => t.length))).toBeLessThanOrEqual(16_000)
    expect(vectors).toHaveLength(texts.length)
    expect(vectors.slice(1).map((v) => v[0])).toEqual(texts.slice(1).map((t) => t.length))
  })
})
