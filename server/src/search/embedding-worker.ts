// Worker thread of the local embedder (#496): tokenisation and ONNX
// inference block the thread they run on for a whole batch (measured 0.45 s
// per batch of 8 on a fast laptop, seconds on a lab runner), so on the main
// thread one large file kept `/health` and every request waiting. LocalEmbedder
// (embeddings.ts) owns this thread and sends it one batch at a time.
//
// Self-contained on purpose: no imports from this repository. It then loads
// under tsx (production runs `node --import tsx`, and a worker inherits the
// parent's execArgv) and under Node's own type stripping (vitest starts it
// outside Vite's transform pipeline, where `./x.js` -> `./x.ts` does not map).
import { pipeline } from '@huggingface/transformers'
import { parentPort } from 'node:worker_threads'

const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5'

/** One batch: texts already cut to their maximum length by the caller. */
export interface EmbedBatchRequest {
  id: number
  texts: string[]
}

export type EmbedBatchResponse =
  | { id: number; vectors: number[][] }
  | { id: number; error: { name: string; message: string } }

type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>

let extractor: Promise<Extractor> | null = null

function loadExtractor(): Promise<Extractor> {
  if (!extractor) {
    const loading = pipeline('feature-extraction', EMBEDDING_MODEL) as unknown as Promise<Extractor>
    // A failed load (download error, missing file) is retried by the next batch.
    loading.catch(() => {
      if (extractor === loading) extractor = null
    })
    extractor = loading
  }
  return extractor
}

async function embedBatch({ id, texts }: EmbedBatchRequest): Promise<EmbedBatchResponse> {
  try {
    const extract = await loadExtractor()
    const output = await extract(texts, { pooling: 'mean', normalize: true })
    return { id, vectors: output.tolist() }
  } catch (err) {
    const { name, message } = err instanceof Error ? err : new Error(String(err))
    return { id, error: { name, message } }
  }
}

const port = parentPort
if (port) port.on('message', (req: EmbedBatchRequest) => void embedBatch(req).then((res) => port.postMessage(res)))
