import type { ToolProfile } from './server.js'

/**
 * `initialize.instructions` (#435): the rules an agent needs before its first
 * call, one fixed text per profile. It names no id, date or pin, so every
 * token of a profile gets the same bytes and a client can cache them (#681);
 * it counts in the reader budget (mcp-tool-budget.test.ts), so the reader
 * text holds only the budget, cursor and manual rules. Profiles that list
 * the note writes add how a whole body merges and how a write is retried.
 */
const READ_RULES =
  'Answers fit `budget_tokens` (characters / 4) and end with `truncated`; for more, repeat the call with its `cursor`. ' +
  'read_note and read_file page long bodies only this way. Manuals: elara://manual/conventions and one per tool family.'

const WRITE_RULES =
  ' A whole `body` merges from `base_rev`, else from your last read of the note; `ops` edit the live text. Retry a write with the same `idempotency_key`.'

export function instructionsFor(profile: ToolProfile): string {
  return profile === 'reader' ? READ_RULES : READ_RULES + WRITE_RULES
}
