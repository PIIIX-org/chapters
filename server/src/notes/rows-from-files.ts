/**
 * Last-resort import (ADR-003 Q9 default, S6, #495): rebuilds note rows from
 * the `.md` files when the database lost them (no usable pg_dump, a restore
 * older than the files). The database is the only full recovery source since
 * ADR-003: revisions, CRDT history and anything not yet projected to a file
 * are not in the files and are not recovered.
 *
 * For every vault directory under `DATA_DIR/vaults` (one vault with
 * `vaultId`), every `*.md` outside `assets/` and the dot-directories:
 * - no live row at that path: the note is created through the store
 *   (`createNote`: row, revision, links, projections, embedding job), and the
 *   projector then adopts the file as it is when its content equals the row;
 * - a live row that holds the file's content: nothing;
 * - a live row that differs: reported, never overwritten (the row is the
 *   authority; compare with `pnpm doctor`);
 * - a file the projector last wrote for a note that still exists but no
 *   longer at that path (a rename or trash move whose file projection had
 *   not run when the server stopped): skipped, never resurrected;
 * - a generated `index.md` (no frontmatter): skipped; any other file that
 *   does not parse, or that the store refuses: reported as failed.
 * The note is created from the file's frontmatter as it is (no `timestamp`
 * added), so the projector adopts the file byte for byte. A `.crdt/<path>.bin`
 * left beside a created note is listed (`crdtBins`): it holds the editor
 * state of the lost row; `pnpm doctor` compares it, delete it if it differs.
 * A vault directory without a vault row is skipped, or, with `ownerEmail`,
 * gets a vault row with that id owned by that user.
 *
 * Unless `dryRun`, it holds the exclusive instance maintenance lock
 * (maintenance-lock.ts) for the whole run, so it refuses to run while a
 * server or writing CLI is up, and a server started meanwhile refuses to
 * start; if the lock's connection drops it stops before the next write.
 * Before the scan it drains every pending projection and store job (as
 * store-export-legacy does), so the files on disk match the rows that still
 * exist. The dry run reads only and takes no lock.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { compareNoteFile, vaultMarkdownFiles } from './integrity.js'
import { holdInstanceLock } from './maintenance-lock.js'
import { parseNote, type OkfNote } from './okf.js'
import { STORE_JOBS, flushProjections } from './projector.js'
import { createNote, getLiveNote, vaultDir } from './store.js'
import { crdtFile } from '../sync/crdt-store.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface RowsFromFilesReport {
  kind: 'elara-rows-from-files'
  dryRun: boolean
  startedAt: string
  finishedAt: string
  /** Notes created (or, in a dry run, that would be). */
  created: Array<{ vaultId: string; path: string }>
  unchanged: number
  /** Files whose live row holds other content: left alone. */
  differs: Array<{ vaultId: string; path: string; detail: string }>
  /** `.crdt` bins beside created notes: the lost row's editor state (compare with `pnpm doctor`). */
  crdtBins: Array<{ vaultId: string; path: string }>
  /** Generated `index.md` files, files of notes that moved, files removed during the run. */
  skipped: Array<{ vaultId: string; path: string; reason: string }>
  failed: Array<{ vaultId: string; path: string; error: string }>
  /** Vault rows created (or, in a dry run, that would be) for directories without one. */
  vaultsCreated: string[]
  /** Vault directories without a live vault row that were skipped. */
  vaultsSkipped: Array<{ vaultId: string; reason: string }>
}

/** The owner email does not belong to an active user. */
export class UnknownOwnerError extends Error {
  constructor(email: string) {
    super(`--owner ${email}: no such user`)
  }
}

export async function rowsFromFiles(options: { dryRun?: boolean; vaultId?: string; ownerEmail?: string } = {}): Promise<RowsFromFilesReport> {
  const dryRun = options.dryRun ?? false
  let lost = false
  const lock = dryRun ? null : await holdInstanceLock('exclusive', { onLost: () => (lost = true) })
  const report: RowsFromFilesReport = {
    kind: 'elara-rows-from-files',
    dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    created: [],
    unchanged: 0,
    differs: [],
    crdtBins: [],
    skipped: [],
    failed: [],
    vaultsCreated: [],
    vaultsSkipped: [],
  }
  const stillHeld = (): void => {
    if (lost) throw new Error('the exclusive instance lock was lost (connection dropped): stopped; run rows-from-files again')
  }
  try {
    if (!dryRun) {
      // A rename or trash move committed before the stop may not have moved its file yet: finish them first.
      await db.execute(sql`
        UPDATE note_projections SET lease_until = NULL, attempts = 0
        WHERE applied_seq < target_seq AND projection IN ('file', 'dir_index')`)
      await db.execute(sql`UPDATE jobs SET lease_until = NULL, attempts = 0 WHERE done_at IS NULL AND kind IN ${Object.values(STORE_JOBS)}`)
      await flushProjections()
    }
    let ownerId: string | null = null
    if (options.ownerEmail) {
      const [owner] = (await db.execute(sql`SELECT id FROM users WHERE lower(email) = lower(${options.ownerEmail})`)) as unknown as Array<{
        id: string
      }>
      if (!owner) throw new UnknownOwnerError(options.ownerEmail)
      ownerId = owner.id
    }
    let dirs: string[]
    try {
      dirs = (await readdir(join(config.dataDir, 'vaults'))).filter((name) => UUID.test(name)).sort()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      dirs = []
    }
    if (options.vaultId) dirs = dirs.filter((id) => id === options.vaultId)
    for (const vaultId of dirs) {
      stillHeld()
      const [vault] = (await db.execute(sql`SELECT deleted_at FROM vaults WHERE id = ${vaultId}`)) as unknown as Array<{
        deleted_at: string | null
      }>
      if (vault?.deleted_at) {
        report.vaultsSkipped.push({ vaultId, reason: 'the vault is in the trash' })
        continue
      }
      if (!vault) {
        if (!ownerId) {
          report.vaultsSkipped.push({ vaultId, reason: 'no vault row (pass --owner <email> to create one)' })
          continue
        }
        report.vaultsCreated.push(vaultId)
        if (!dryRun) {
          await db.execute(sql`INSERT INTO vaults (id, name, owner_id) VALUES (${vaultId}, ${`Restored ${vaultId.slice(0, 8)}`}, ${ownerId})`)
        }
      }
      for (const rel of await vaultMarkdownFiles(vaultId)) {
        const path = rel.slice(0, -'.md'.length)
        let raw: string
        try {
          raw = await readFile(join(vaultDir(vaultId), rel), 'utf8')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          report.skipped.push({ vaultId, path: rel, reason: 'removed during the run' })
          continue
        }
        let note: OkfNote
        try {
          note = parseNote(raw)
        } catch (err) {
          if (rel === 'index.md' || rel.endsWith('/index.md')) report.skipped.push({ vaultId, path: rel, reason: 'generated index' })
          else report.failed.push({ vaultId, path: rel, error: err instanceof Error ? err.message : String(err) })
          continue
        }
        const row = vault ? await getLiveNote(vaultId, path).catch(() => null) : null
        if (row) {
          const content = compareNoteFile(raw, { frontmatter: row.frontmatter as Record<string, unknown>, body: row.body })
          if (content.length === 0) report.unchanged++
          else report.differs.push({ vaultId, path: rel, detail: content.map((c) => `${c.problem}: ${c.detail}`).join('; ') })
          continue
        }
        const moved = vault ? await movedOwner(vaultId, rel) : null
        if (moved) {
          report.skipped.push({ vaultId, path: rel, reason: moved })
          continue
        }
        if (dryRun) {
          report.created.push({ vaultId, path })
          await listBin(report, vaultId, path)
          continue
        }
        stillHeld()
        try {
          await createNote(vaultId, { path, frontmatter: note.frontmatter, body: note.body }, undefined, { asImported: true })
          report.created.push({ vaultId, path })
          await listBin(report, vaultId, path)
        } catch (err) {
          report.failed.push({ vaultId, path: rel, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    // The projector adopts the files the rows were made from and writes the generated indexes.
    if (!dryRun && report.created.length > 0) await flushProjections()
    stillHeld()
  } finally {
    await lock?.release()
  }
  report.finishedAt = new Date().toISOString()
  return report
}

/**
 * Why a file with no live row at its path belongs to a note that still
 * exists elsewhere: the projector's record names an owner that is now at
 * another path or in the trash (its projection had not run). Null when the
 * file has no such owner, so it is imported.
 */
async function movedOwner(vaultId: string, rel: string): Promise<string | null> {
  const [owner] = (await db.execute(sql`
    SELECT n.id, n.path, n.deleted_at FROM projected_files f JOIN notes n ON n.id = f.owner_id
    WHERE f.vault_id = ${vaultId} AND f.path = ${rel} AND f.owner_kind = 'note'`)) as unknown as Array<{
    id: string
    path: string
    deleted_at: string | null
  }>
  if (!owner) return null
  return owner.deleted_at ? `its note ${owner.id} is in the trash` : `its note ${owner.id} moved to ${owner.path}`
}

/** Lists the `.crdt/<path>.bin` beside a created note, if there is one. */
async function listBin(report: RowsFromFilesReport, vaultId: string, path: string): Promise<void> {
  if (await stat(crdtFile(vaultId, path)).then(() => true, () => false)) report.crdtBins.push({ vaultId, path: `.crdt/${path}.bin` })
}
