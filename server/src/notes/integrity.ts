import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, vaults } from '../db/schema.js'
import { parseNote, type OkfNote } from './okf.js'
import { noteFile } from './store.js'

export interface NoteFileProblem {
  vaultId: string
  vaultName: string
  path: string
  problem: 'missing-file' | 'unparseable' | 'frontmatter-mismatch' | 'body-mismatch'
  detail: string
}

/**
 * Reads every live note's file in live vaults straight from disk and parses it,
 * the same way `readNote` does, then compares it with the note's row. A note
 * whose file fails to parse cannot be opened, edited, or reverted (every write
 * path loads the file first); a file that parses but differs from its row means
 * reads (file) and search/graph/history (row) disagree about the note. This
 * finds both without going through the rate-limited MCP API, and CI runs it
 * over everything the server test suite wrote (#578).
 */
export async function checkNoteFiles(vaultId?: string): Promise<{ checked: number; problems: NoteFileProblem[] }> {
  const rows = await db
    .select({
      vaultId: notes.vaultId,
      vaultName: vaults.name,
      path: notes.path,
      frontmatter: notes.frontmatter,
      body: notes.body,
    })
    .from(notes)
    .innerJoin(vaults, eq(vaults.id, notes.vaultId))
    .where(
      and(
        isNull(notes.deletedAt),
        isNull(vaults.deletedAt),
        vaultId === undefined ? undefined : eq(notes.vaultId, vaultId),
      ),
    )
    .orderBy(asc(vaults.name), asc(notes.path))

  const problems: NoteFileProblem[] = []
  for (const { frontmatter, body, ...note } of rows) {
    let raw: string
    try {
      raw = await readFile(noteFile(note.vaultId, note.path), 'utf8')
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err
      problems.push({ ...note, problem: 'missing-file', detail: 'file not found on disk' })
      continue
    }
    let parsed: OkfNote
    try {
      parsed = parseNote(raw)
    } catch (err) {
      problems.push({ ...note, problem: 'unparseable', detail: err instanceof Error ? err.message : String(err) })
      continue
    }
    // jsonb does not keep key order, so compare key by key, not serialized.
    const rowFrontmatter = frontmatter as Record<string, unknown>
    const differing = [...new Set([...Object.keys(parsed.frontmatter), ...Object.keys(rowFrontmatter)])]
      .filter((key) => !isDeepStrictEqual(parsed.frontmatter[key], rowFrontmatter[key]))
      .sort()
    if (differing.length > 0) {
      problems.push({ ...note, problem: 'frontmatter-mismatch', detail: `differing keys: ${differing.join(', ')}` })
    }
    if (parsed.body !== body) {
      let offset = 0
      while (parsed.body[offset] === body[offset]) offset++
      problems.push({
        ...note,
        problem: 'body-mismatch',
        detail: `first difference at offset ${offset} (file ${parsed.body.length} chars, row ${body.length} chars)`,
      })
    }
  }
  return { checked: rows.length, problems }
}
