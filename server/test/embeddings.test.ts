import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { metricsSnapshot } from '../src/monitoring/metrics.js'
import { EmbeddingWorkerCrashError, LocalEmbedder } from '../src/search/embeddings.js'

// The real model is never loaded: a fake worker with the same message protocol
// answers `[text length, batch number]` per text (test/fixtures/fake-embedding-worker.ts).
// The real worker is covered by embedding-worker.test.ts.
const FAKE_WORKER = new URL('./fixtures/fake-embedding-worker.ts', import.meta.url)

let errorSpy: MockInstance<typeof console.error>
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

/** Which batch (in the worker's order) produced each vector. */
const batchOf = (vectors: number[][]) => vectors.map((v) => v[1])

describe('local embedder', () => {
  it('runs the model on small batches of bounded texts, returning vectors in input order', async () => {
    const embedder = new LocalEmbedder(FAKE_WORKER)
    // One extraction call for a big file: the file text plus many symbol texts.
    // Run as one batch, the pipeline pads all of them to 512 tokens at once —
    // measured ~32 MB of activations per text (30.7 GB for 948 texts).
    const texts = [`src/bundle.mjs\n${'x'.repeat(742_000)}`, ...Array.from({ length: 40 }, (_, i) => `function f${i}`)]
    const vectors = await embedder.embed(texts)

    expect(vectors).toHaveLength(texts.length)
    expect(vectors[0]![0]).toBe(16_000)
    expect(vectors.slice(1).map((v) => v[0])).toEqual(texts.slice(1).map((t) => t.length))
    // 41 texts: six runs of at most 8, in order.
    expect(batchOf(vectors)).toEqual(texts.map((_, i) => Math.floor(i / 8)))
  })

  it('serves concurrent callers batch by batch, so a query does not wait behind a whole large file', async () => {
    const embedder = new LocalEmbedder(FAKE_WORKER)
    const file = embedder.embed(Array.from({ length: 24 }, (_, i) => `symbol ${i}`))
    const query = embedder.embed(['where is the login handler'])
    const other = embedder.embed(Array.from({ length: 9 }, (_, i) => `note ${i}`))

    // Turns: file, query, other, file, other, file.
    expect(batchOf(await query)).toEqual([1])
    expect(batchOf(await other)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 4])
    expect(batchOf(await file)).toEqual([...Array(8).fill(0), ...Array(8).fill(3), ...Array(8).fill(5)])
  })

  it('a worker that exits fails only the request it was running, reports it, and the next batch gets a new worker', async () => {
    const embedder = new LocalEmbedder(FAKE_WORKER)
    expect(batchOf(await embedder.embed(['warm']))).toEqual([0])
    const before = metricsSnapshot()

    const crashing = embedder.embed(['exit'])
    const behind = embedder.embed(['queued behind the crash'])
    await expect(crashing).rejects.toBeInstanceOf(EmbeddingWorkerCrashError)
    await expect(crashing).rejects.toThrow('embedding worker exited with code 3')
    // A fresh worker: its batch counter starts again at 0.
    expect(batchOf(await behind)).toEqual([0])

    const after = metricsSnapshot()
    expect(after.jobs.embedding.failed).toBe(before.jobs.embedding.failed + 1)
    expect(after.errors.at(-1)).toMatchObject({ type: 'job', job: 'embedding', error: { name: 'EmbeddingWorkerCrash' } })
  })

  it('a worker that dies on an uncaught exception keeps that exception as the cause', async () => {
    const embedder = new LocalEmbedder(FAKE_WORKER)
    const err: unknown = await embedder.embed(['throw']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EmbeddingWorkerCrashError)
    expect((err as Error).cause).toMatchObject({ message: 'worker blew up' })
    expect(batchOf(await embedder.embed(['next']))).toEqual([0])
  })

  it('a batch the model rejects fails its request with the model error, and the worker stays up', async () => {
    const embedder = new LocalEmbedder(FAKE_WORKER)
    expect(batchOf(await embedder.embed(['first']))).toEqual([0])
    await expect(embedder.embed(['fail'])).rejects.toMatchObject({ name: 'TypeError', message: 'bad input' })
    expect(batchOf(await embedder.embed(['second']))).toEqual([1])
  })

  it('an empty request needs no worker', async () => {
    expect(await new LocalEmbedder(new URL('./fixtures/missing-worker.ts', import.meta.url)).embed([])).toEqual([])
  })
})
