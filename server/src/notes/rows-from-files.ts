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
 * - a generated `index.md` (no frontmatter): skipped; any other file that
 *   does not parse, or that the store refuses: reported as failed.
 * A vault directory without a vault row is skipped, or, with `ownerEmail`,
 * gets a vault row with that id owned by that user.
 *
 * Unless `dryRun`, it holds the exclusive instance maintenance lock
 * (maintenance-lock.ts) for the whole run, so it refuses to run while a
 * server or writing CLI is up, and a server started meanwhile refuses to
 * start. The dry run reads only and takes no lock.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { compareNoteFile, vaultMarkdownFiles } from './integrity.js'
import { holdInstanceLock } from './maintenance-lock.js'
import { parseNote, type OkfNote } from './okf.js'
import { flushProjections } from './projector.js'
import { createNote, getLiveNote, vaultDir } from './store.js'

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
  /** Generated `index.md` files. */
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
    skipped: [],
    failed: [],
    vaultsCreated: [],
    vaultsSkipped: [],
  }
  try {
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
      if (lost) throw new Error('the exclusive instance lock was lost (connection dropped): stopped')
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
        const raw = await readFile(join(vaultDir(vaultId), rel), 'utf8')
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
        if (dryRun) {
          report.created.push({ vaultId, path })
          continue
        }
        try {
          await createNote(vaultId, { path, frontmatter: note.frontmatter, body: note.body })
          report.created.push({ vaultId, path })
        } catch (err) {
          report.failed.push({ vaultId, path: rel, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    // The projector adopts the files the rows were made from and writes the generated indexes.
    if (!dryRun && report.created.length > 0) await flushProjections()
  } finally {
    await lock?.release()
  }
  report.finishedAt = new Date().toISOString()
  return report
}
