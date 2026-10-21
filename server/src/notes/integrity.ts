import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { parseNote, type OkfNote } from './okf.js'
import { noteFile, vaultDir } from './store.js'

export interface NoteFileProblem {
  vaultId: string
  vaultName: string
  path: string
  problem: 'missing-file' | 'unparseable' | 'frontmatter-mismatch' | 'body-mismatch' | 'orphan-file'
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

/** How a file's text differs from a row: the check-notes comparison, also used by the doctor. */
export type FileContentProblem = Pick<NoteFileProblem, 'problem' | 'detail'>

/**
 * Compares the text of a note file with the row's frontmatter and body:
 * frontmatter key by key with deep equality (jsonb does not keep key order),
 * body exactly. Returns nothing when the file holds the row's content.
 */
export function compareNoteFile(raw: string, row: { frontmatter: Record<string, unknown>; body: string }): FileContentProblem[] {
  let parsed: OkfNote
  try {
    parsed = parseNote(raw)
  } catch (err) {
    return [{ problem: 'unparseable', detail: err instanceof Error ? err.message : String(err) }]
  }
  const problems: FileContentProblem[] = []
  const differing = [...new Set([...Object.keys(parsed.frontmatter), ...Object.keys(row.frontmatter)])]
    .filter((key) => !isDeepStrictEqual(parsed.frontmatter[key], row.frontmatter[key]))
    .sort()
  if (differing.length > 0) problems.push({ problem: 'frontmatter-mismatch', detail: `differing keys: ${differing.join(', ')}` })
  if (parsed.body !== row.body) {
    let offset = 0
    while (parsed.body[offset] === row.body[offset]) offset++
    problems.push({
      problem: 'body-mismatch',
      detail: `first difference at offset ${offset} (file ${parsed.body.length} chars, row ${row.body.length} chars)`,
    })
  }
  return problems
}

/**
 * Read-only file checker (ADR-003 §7 "check-notes stays read-only"). The
 * database is the authority and the `.md` files are a projection the
 * projector writes after commit, so a note's file is compared with its row
 * only where its `file` projection is applied at the row's current `seq`;
 * notes whose projections are still pending are listed separately (a file
 * behind its row there is expected, not damage). A file that differs from
 * an applied row, is missing or does not parse is a problem, and so is an
 * orphan: a `.md` file the projector never wrote that no note or generated
 * index owns (#495). CI runs this over everything the server test suite
 * wrote (#578).
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
    for (const problem of compareNoteFile(raw, row)) problems.push({ ...note, ...problem })
  }
  for (const orphan of await orphanFiles(vaultId)) {
    problems.push({
      vaultId: orphan.vaultId,
      vaultName: orphan.vaultName,
      path: orphan.path,
      problem: 'orphan-file',
      detail: 'no note, generated index or projector record owns this file',
    })
  }
  return { checked, problems, pending }
}

/**
 * Every `*.md` file under a vault directory, vault-relative, outside
 * `assets/` and every dot-directory (`.trash`, `.conflicts`, `.orphans`,
 * `.migration`, `.crdt*`): the files the orphan sweep (§7 boot step 9) looks at.
 */
export async function vaultMarkdownFiles(vaultId: string): Promise<string[]> {
  const root = vaultDir(vaultId)
  const found: string[] = []
  async function visit(rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || child === 'assets') continue
        await visit(child)
      } else if (entry.isFile() && entry.name.endsWith('.md')) found.push(child)
    }
  }
  await visit('')
  return found.sort()
}

/** A `.md` file with no owner: see orphanFiles. */
export interface OrphanFile {
  vaultId: string
  vaultName: string
  path: string
}

/**
 * The `.md` files of live vaults that the orphan sweep would move (§7 boot
 * step 9): no `projected_files` row, no live note at that path and, for an
 * `index.md`, no live note under its directory. Read-only.
 */
export async function orphanFiles(vaultId?: string, client: Pick<typeof db, 'execute'> = db): Promise<OrphanFile[]> {
  const vaults = (await client.execute(sql`
    SELECT id, name FROM vaults WHERE deleted_at IS NULL ${vaultId ? sql`AND id = ${vaultId}` : sql``}
    ORDER BY name, id`)) as unknown as Array<{ id: string; name: string }>
  const orphans: OrphanFile[] = []
  for (const vault of vaults) {
    const files = await vaultMarkdownFiles(vault.id)
    if (files.length === 0) continue
    const recorded = new Set(
      ((await client.execute(sql`SELECT path FROM projected_files WHERE vault_id = ${vault.id}`)) as unknown as Array<{ path: string }>).map(
        (r) => r.path,
      ),
    )
    const live = new Set(
      ((await client.execute(sql`SELECT path FROM notes WHERE vault_id = ${vault.id} AND deleted_at IS NULL`)) as unknown as Array<{
        path: string
      }>).map((r) => r.path),
    )
    const dirs = new Set<string>([''])
    for (const path of live) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    }
    for (const rel of files) {
      if (recorded.has(rel) || live.has(rel.slice(0, -3))) continue
      if (rel === 'index.md' ? live.size > 0 : rel.endsWith('/index.md') && dirs.has(rel.slice(0, -'/index.md'.length))) continue
      orphans.push({ vaultId: vault.id, vaultName: vault.name, path: rel })
    }
  }
  return orphans
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
