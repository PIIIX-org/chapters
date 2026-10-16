// The local arm's grep, run in a worker thread so that the caller can stop
// it at a time limit: a model-supplied regular expression can backtrack for
// minutes on one line, and a synchronous loop cannot be interrupted
// (lib/tools.ts terminates this worker). Plain JavaScript so Node and Bun
// both load it without a build step.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

const { root, files, pattern, flags, max, lineChars, maxFileBytes } = workerData
const re = new RegExp(pattern, flags)
const hits = []
let total = 0
for (const f of files) {
  const full = join(root, f)
  if (statSync(full).size > maxFileBytes) continue
  const buf = readFileSync(full)
  if (buf.subarray(0, 8192).includes(0)) continue
  const lines = buf.toString('utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue
    total++
    if (hits.length < max) hits.push(`${f}:${i + 1}:${lines[i].slice(0, lineChars)}`)
  }
}
parentPort.postMessage({ total, hits })
