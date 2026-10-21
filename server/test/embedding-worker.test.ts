import { pipeline } from '@huggingface/transformers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTransientDownloadFailure } from './fixtures/model-download.js'

// The real bge-small model (#496): Transformers.js downloads it into its cache
// on the first run (~133 MB), so the timeout leaves room for that.
// Opt-in (#851): the unit suite must not depend on the network, so this file
// runs only with ELARA_REAL_MODEL_TESTS=1. The unit suite checks the event
// loop against the fake worker (embeddings.test.ts).
const MODEL_TIMEOUT_MS = 300_000
const REAL_MODEL = process.env.ELARA_REAL_MODEL_TESTS === '1'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

/** Texts shaped like one big source file: the file itself plus symbol snippets, all long enough to hit 512 tokens. */
function bigFileTexts(): string[] {
  const decl = (i: number) => `function a${i}(e,t){var n=e+t|0;for(var r=0;r<n;r++)n^=r<<${i % 7};return n+"${`k${i}_`.repeat(400)}"}`
  const file = `dist/cli.bundle.mjs\n${Array.from({ length: 200 }, (_, i) => decl(i)).join('\n')}`
  const symbols = Array.from({ length: 23 }, (_, i) => `function a${i} in dist/cli.bundle.mjs:${i + 1}\n${decl(i).slice(0, 1500)}`)
  return [file, ...symbols]
}

describe.skipIf(!REAL_MODEL)('local embedder off the main thread, real model (#496)', () => {
  it(
    'keeps the event loop responsive while it embeds a large file, with the vectors the main-thread pipeline gives',
    async (ctx) => {
      vi.stubEnv('EMBEDDINGS', 'local')
      // Dynamic: config reads EMBEDDINGS when the module graph loads.
      vi.resetModules()
      const { embedder } = await import('../src/search/embeddings.js')
      // Model download and load stay outside the measured window. A download
      // cut by the network or a Hugging Face outage is reported as skipped,
      // with the reason; a 404 or a wrong model id fails (fixtures/model-download.ts).
      try {
        await embedder.embed(['warm up'])
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (isTransientDownloadFailure(message)) ctx.skip(`model download failed: ${message}`)
        throw err
      }

      const texts = bigFileTexts()
      // A /health probe is a timer callback away: it can only answer when the
      // event loop is free. Inference on the main thread holds it for a whole
      // ONNX run (~0.5 s per batch of 8 on a fast laptop, seconds on a runner).
      // A real interval on purpose: the lag of the real event loop is what is measured.
      let maxLagMs = 0
      let last = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        maxLagMs = Math.max(maxLagMs, now - last - 20)
        last = now
      }, 20)
      let vectors: number[][]
      try {
        vectors = await embedder.embed(texts)
      } finally {
        clearInterval(timer)
      }
      expect(maxLagMs).toBeLessThan(200)

      // Same vectors as before the move: the pipeline called here, on this
      // thread, with the old batching (8 texts, each cut to 16k characters).
      const pipe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5')
      const expected: number[][] = []
      for (let i = 0; i < texts.length; i += 8) {
        const batch = texts.slice(i, i + 8).map((t) => t.slice(0, 16_000))
        expected.push(...((await pipe(batch, { pooling: 'mean', normalize: true })).tolist() as number[][]))
      }
      expect(vectors).toHaveLength(texts.length)
      expect(vectors[0]).toHaveLength(384)
      expect(vectors).toEqual(expected)
    },
    MODEL_TIMEOUT_MS,
  )
})
