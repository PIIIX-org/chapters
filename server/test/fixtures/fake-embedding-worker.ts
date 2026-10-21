// Stands in for src/search/embedding-worker.ts in test/embeddings.test.ts: same
// message protocol, no model. Each vector is `[text length, batch number]`, the
// batch number counting batches this worker thread has run (0 = its first).
// A first text of `exit`, `throw` or `fail` makes the worker exit, die on an
// uncaught exception, or answer with an error.
import { parentPort } from 'node:worker_threads'

let batches = 0
const port = parentPort!
port.on('message', ({ id, texts }: { id: number; texts: string[] }) => {
  if (texts[0] === 'exit') process.exit(3)
  if (texts[0] === 'throw') throw new Error('worker blew up')
  if (texts[0] === 'fail') {
    port.postMessage({ id, error: { name: 'TypeError', message: 'bad input' } })
    return
  }
  const batch = batches++
  port.postMessage({ id, vectors: texts.map((t) => [t.length, batch]) })
})
