/**
 * The note fields a write answers, over MCP (#427) and REST (#931): what a
 * caller needs of the note it wrote. The row's other columns (`embedding`,
 * `deletedAt`, `seq`, bookkeeping) stay internal: the embedding alone was 93%
 * of an edit_note answer.
 */
export const NOTE_REPLY_FIELDS = ['id', 'vaultId', 'type', 'name', 'path', 'frontmatter', 'body', 'createdAt', 'updatedAt'] as const

/** The NOTE_REPLY_FIELDS of note `row`, and `rev` (its `seq`, what GET answers and PUT takes back as `baseRev`). */
export function noteReply(row: { seq: number } & object): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const key of NOTE_REPLY_FIELDS) if (key in row) fields[key] = (row as Record<string, unknown>)[key]
  return { ...fields, rev: row.seq }
}
