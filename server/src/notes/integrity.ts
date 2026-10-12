import { readFile } from 'node:fs/promises'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, vaults } from '../db/schema.js'
import { parseNote } from './okf.js'
import { noteFile } from './store.js'

export interface NoteFileProblem {
  vaultId: string
  vaultName: string
  path: string
  problem: 'missing-file' | 'unparseable'
  detail: string
}

/**
 * Reads every live note's file in live vaults straight from disk and parses it,
 * the same way `readNote` does. A note whose file fails to parse cannot be
 * opened, edited, or reverted (every write path loads the file first), so this
 * finds such notes without going through the rate-limited MCP API.
 */
export async function checkNoteFiles(vaultId?: string): Promise<{ checked: number; problems: NoteFileProblem[] }> {
  const rows = await db
    .select({ vaultId: notes.vaultId, vaultName: vaults.name, path: notes.path })
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
  for (const row of rows) {
    let raw: string
    try {
      raw = await readFile(noteFile(row.vaultId, row.path), 'utf8')
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err
      problems.push({ ...row, problem: 'missing-file', detail: 'file not found on disk' })
      continue
    }
    try {
      parseNote(raw)
    } catch (err) {
      problems.push({ ...row, problem: 'unparseable', detail: err instanceof Error ? err.message : String(err) })
    }
  }
  return { checked: rows.length, problems }
}
