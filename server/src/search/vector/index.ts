import { config } from '../../config.js'
import { ChromaVectorStore } from './chroma-store.js'
import { MemoryVectorStore } from './memory-store.js'
import type { VectorStore } from './vector-store.js'

export * from './vector-store.js'
export { ChromaVectorStore } from './chroma-store.js'
export { MemoryVectorStore } from './memory-store.js'

export const vectorStore: VectorStore =
  config.vectorStore === 'memory'
    ? new MemoryVectorStore()
    : new ChromaVectorStore({
        url: config.chromaUrl,
        authToken: config.chromaAuthToken,
        prefix: config.chromaPrefix,
      })
