/**
 * The child process of extraction-child.ts: parses what the server sends over
 * the IPC channel, one request at a time, with the Swift grammar loaded here and
 * not in the server. Started with V8's Wasm tier-up off (`execArgv`).
 */
import { extractHere, isSupportedLanguage } from './extraction.js'
import type { IsolatedReply, IsolatedRequest } from './extraction-child.js'

const send = (reply: IsolatedReply): void => {
  process.send?.(reply)
}

process.on('message', (request: IsolatedRequest) => {
  const { id, language, content, path, edges, budgetMs } = request
  if (!isSupportedLanguage(language)) return send({ id, error: `unsupported language for extraction: ${language}` })
  extractHere(language, content, path, { edges, deadline: Date.now() + budgetMs }).then(
    (result) => send({ id, result }),
    (err: unknown) => send({ id, error: err instanceof Error ? err.message : String(err) }),
  )
})

// The parent is gone (its channel closed) or asks to stop: no orphan.
process.on('disconnect', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
