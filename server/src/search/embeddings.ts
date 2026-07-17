import { createHash } from 'node:crypto'
import { config } from '../config.js'

export const EMBEDDING_DIM = 384

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
}

/**
 * Deterministic bag-of-words embedder for tests/dev: each word hashes to
 * a signed basis dimension; texts sharing vocabulary land near each
 * other. No model download, no network — sandbox-test-protocol safe.
 */
class FakeEmbedder implements Embedder {
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.one(t)))
  }

  private one(text: string): number[] {
    const vec = new Array<number>(EMBEDDING_DIM).fill(0)
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
    for (const word of words) {
      const digest = createHash('sha256').update(word).digest()
      const dim = digest.readUInt16BE(0) % EMBEDDING_DIM
      const sign = digest[2]! % 2 === 0 ? 1 : -1
      vec[dim]! += sign
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
    return vec.map((v) => v / norm)
  }
}

/** bge-small-en-v1.5 via Transformers.js ONNX — local CPU, content never leaves the instance. */
class LocalEmbedder implements Embedder {
  private pipe: Promise<unknown> | null = null

  private async pipeline() {
    this.pipe ??= import('@huggingface/transformers').then(({ pipeline }) =>
      pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5'),
    )
    return (await this.pipe) as (
      texts: string[],
      opts: { pooling: string; normalize: boolean },
    ) => Promise<{ tolist(): number[][] }>
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.pipeline()
    const output = await pipe(texts, { pooling: 'mean', normalize: true })
    return output.tolist()
  }
}

export const embedder: Embedder =
  config.embeddings === 'local' ? new LocalEmbedder() : new FakeEmbedder()
