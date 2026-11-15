/**
 * The child process of extraction-child.ts: parses what the server sends over
 * the IPC channel, one request at a time, with the Swift grammar loaded here and
 * not in the server. Started with V8's Wasm tier-up off (`execArgv`).
 *
 * It owns the deadline of each parse (`budgetMs`, from when the grammar is
 * loaded), cuts every answer to the limits the server accepts (`encodeResult`),
 * and retires itself after an answer when its RSS is over a limit or it has
 * parsed enough files: `--max-old-space-size` caps its JS heap only, and the
 * Wasm memory and compiled code beside it are not capped. The answer says so
 * (`retire`), so the server starts a new child for the next request instead of
 * sending one to a process that is exiting.
 */
import { extractHere, isSupportedLanguage } from './extraction.js'
import { DEFAULT_CHILD_MAX_PARSES, DEFAULT_CHILD_RSS_MB, encodeResult, type IsolatedReply, type IsolatedRequest } from './extraction-child.js'

const positive = (raw: string | undefined, fallback: number): number => (Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallback)
const rssLimitBytes = positive(process.env.ELARA_ISOLATED_CHILD_RSS_MB, DEFAULT_CHILD_RSS_MB) * 1024 * 1024
const maxParses = positive(process.env.ELARA_ISOLATED_CHILD_MAX_PARSES, DEFAULT_CHILD_MAX_PARSES)
let parses = 0

function send(reply: IsolatedReply, then: () => void = () => {}): void {
  process.send?.(reply, then)
}

process.on('message', (request: IsolatedRequest) => {
  const { id, language, content, path, edges, budgetMs } = request
  if (!isSupportedLanguage(language)) return send({ id, error: `unsupported language for extraction: ${language}` })
  extractHere(language, content, path, { edges, budgetMs }).then(
    (result) => {
      const retire = request.retire === true || ++parses >= maxParses || process.memoryUsage.rss() > rssLimitBytes
      send({ id, payload: encodeResult(result), ...(retire ? { retire: true } : {}) }, retire ? () => process.exit(0) : undefined)
    },
    (err: unknown) => send({ id, error: err instanceof Error ? err.message : String(err) }),
  )
})

// The parent is gone (its channel closed) or asks to stop: no orphan.
process.on('disconnect', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
