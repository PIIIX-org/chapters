import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { parseNote, type OkfNote } from './okf.js'
import { noteFile } from './store.js'

export interface NoteFileProblem {
  vaultId: string
  vaultName: string
  path: string
  problem: 'missing-file' | 'unparseable' | 'frontmatter-mismatch' | 'body-mismatch'
  detail: string
}

/** A live note whose `file` projection has not reached its row's `seq` yet (ADR-003 §7). */
export interface PendingProjection {
  vaultId: string
  vaultName: string
  path: string
  projection: string
  appliedSeq: number
  targetSeq: number
  lastError: string | null
}

interface Row {
  vault_id: string
  vault_name: string
  path: string
  frontmatter: Record<string, unknown>
  body: string
  file_applied: boolean
}

/**
 * Read-only file checker (ADR-003 §7 "check-notes stays read-only"). The
 * database is the authority and the `.md` files are a projection the
 * projector writes after commit, so a note's file is compared with its row
 * only where its `file` projection is applied at the row's current `seq`;
 * notes whose projections are still pending are listed separately (a file
 * behind its row there is expected, not damage). A file that differs from
 * an applied row, is missing or does not parse is a problem. CI runs this
 * over everything the server test suite wrote (#578).
 */
export async function checkNoteFiles(
  vaultId?: string,
): Promise<{ checked: number; problems: NoteFileProblem[]; pending: PendingProjection[] }> {
  const rows = (await db.execute(sql`
    SELECT n.vault_id, v.name AS vault_name, n.path, n.frontmatter, n.body,
      COALESCE(p.applied_seq >= n.seq, true) AS file_applied
    FROM notes n
    JOIN vaults v ON v.id = n.vault_id
    LEFT JOIN note_projections p ON p.note_id = n.id AND p.projection = 'file'
    WHERE n.deleted_at IS NULL AND v.deleted_at IS NULL ${vaultId ? sql`AND n.vault_id = ${vaultId}` : sql``}
    ORDER BY v.name, n.path`)) as unknown as Row[]
  const pending = await pendingProjectionList(vaultId)

  const problems: NoteFileProblem[] = []
  let checked = 0
  for (const row of rows) {
    if (!row.file_applied) continue
    checked++
    const note = { vaultId: row.vault_id, vaultName: row.vault_name, path: row.path }
    let raw: string
    try {
      raw = await readFile(noteFile(row.vault_id, row.path), 'utf8')
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
    const differing = [...new Set([...Object.keys(parsed.frontmatter), ...Object.keys(row.frontmatter)])]
      .filter((key) => !isDeepStrictEqual(parsed.frontmatter[key], row.frontmatter[key]))
      .sort()
    if (differing.length > 0) {
      problems.push({ ...note, problem: 'frontmatter-mismatch', detail: `differing keys: ${differing.join(', ')}` })
    }
    if (parsed.body !== row.body) {
      let offset = 0
      while (parsed.body[offset] === row.body[offset]) offset++
      problems.push({
        ...note,
        problem: 'body-mismatch',
        detail: `first difference at offset ${offset} (file ${parsed.body.length} chars, row ${row.body.length} chars)`,
      })
    }
  }
  return { checked, problems, pending }
}

/** Every pending `file`/`dir_index` projection of a live note in a live vault. */
export async function pendingProjectionList(vaultId?: string): Promise<PendingProjection[]> {
  const rows = (await db.execute(sql`
    SELECT n.vault_id, v.name AS vault_name, n.path, p.projection, p.applied_seq, p.target_seq, p.last_error
    FROM note_projections p
    JOIN notes n ON n.id = p.note_id
    JOIN vaults v ON v.id = n.vault_id
    WHERE p.applied_seq < p.target_seq AND p.projection IN ('file', 'dir_index') AND v.deleted_at IS NULL
      ${vaultId ? sql`AND n.vault_id = ${vaultId}` : sql``}
    ORDER BY v.name, n.path, p.projection`)) as unknown as Array<{
    vault_id: string
    vault_name: string
    path: string
    projection: string
    applied_seq: string
    target_seq: string
    last_error: string | null
  }>
  return rows.map((r) => ({
    vaultId: r.vault_id,
    vaultName: r.vault_name,
    path: r.path,
    projection: r.projection,
    appliedSeq: Number(r.applied_seq),
    targetSeq: Number(r.target_seq),
    lastError: r.last_error,
  }))
}
