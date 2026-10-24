import type { ToolProfile } from './server.js'

/**
 * `initialize.instructions` (#435): the rules an agent needs before its first
 * call, one fixed text per profile. It names no id, date or pin, so every
 * token of a profile gets the same bytes and a client can cache them (#681);
 * it counts in the reader budget (mcp-tool-budget.test.ts), so the reader
 * text holds only the budget, cursor and manual rules. Only tools with
 * `budget_tokens` answer with `truncated` (`search`, `list_vaults` and
 * `list_repositories` answer bare arrays). Profiles that list the note
 * writes add how a whole body merges (the last read is recorded only for an
 * unpaged `read_note`, last-read.ts) and how a note write is retried (only
 * the note writes take `idempotency_key`; admin's other writes refuse it).
 */
const READ_RULES =
  'Tools with `budget_tokens` (characters / 4) fit it and end with `truncated`; for more, repeat the call with its `cursor`. ' +
  'read_note and read_file page long bodies only this way. Manuals: elara://manual/conventions and one per tool family.'

const WRITE_RULES =
  ' A whole `body` merges from `base_rev`, else from your last unpaged read_note; after a paged read send its `rev` as `base_rev`. ' +
  '`ops` edit the live text. Retry a note write with the same `idempotency_key`.'

export function instructionsFor(profile: ToolProfile): string {
  return profile === 'reader' ? READ_RULES : READ_RULES + WRITE_RULES
}
