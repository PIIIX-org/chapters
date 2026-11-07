// Worker thread of the local verifier (#1061): the cross-encoder runs here so scoring 30 passages never blocks the
// event loop (the embedder does the same, embedding-worker.ts). Self-contained for the same reason: no imports from
// this repository, so it loads under tsx, Node's type stripping and vitest alike.
import { AutoModelForSequenceClassification, AutoTokenizer } from '@huggingface/transformers'
import { parentPort, workerData } from 'node:worker_threads'

const { model, dtype, maxTokens } = workerData as { model: string; dtype: string; maxTokens: number }

export interface VerifyRequest {
  id: number
  query: string
  texts: string[]
}

export type VerifyResponse = { id: number; scores: number[] } | { id: number; error: { name: string; message: string } }

interface Loaded {
  tokenizer: (a: string[], o: Record<string, unknown>) => Record<string, unknown>
  model: (inputs: Record<string, unknown>) => Promise<{ logits: { data: ArrayLike<number> } }>
}

let loaded: Promise<Loaded> | null = null

function load(): Promise<Loaded> {
  if (!loaded) {
    const loading = Promise.all([AutoTokenizer.from_pretrained(model), AutoModelForSequenceClassification.from_pretrained(model, { dtype: dtype as 'int8' })]).then(
      ([tokenizer, m]) => ({ tokenizer, model: m }) as unknown as Loaded,
    )
    // A failed load (download error) is retried by the next request.
    loading.catch(() => {
      if (loaded === loading) loaded = null
    })
    loaded = loading
  }
  return loaded
}

async function verify({ id, query, texts }: VerifyRequest): Promise<VerifyResponse> {
  try {
    const m = await load()
    const inputs = m.tokenizer(Array<string>(texts.length).fill(query), { text_pair: texts, padding: true, truncation: true, max_length: maxTokens })
    const { logits } = await m.model(inputs)
    return { id, scores: Array.from(logits.data, (x) => 1 / (1 + Math.exp(-x))) }
  } catch (err) {
    const { name, message } = err instanceof Error ? err : new Error(String(err))
    return { id, error: { name, message } }
  }
}

const port = parentPort
if (port) {
  port.on('message', (req: VerifyRequest | { warm: true }) => {
    if ('warm' in req) void load().catch(() => {})
    else void verify(req).then((res) => port.postMessage(res))
  })
}
