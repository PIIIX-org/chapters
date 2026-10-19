import AdmZip from 'adm-zip'
import { readFile } from 'node:fs/promises'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { teams, users, vaults, vaultShares } from '../db/schema.js'
import { listAssets, listNotes, noteFile, readAsset, readNote, trashFile } from '../notes/store.js'
import { serializeNote, type Frontmatter } from '../notes/okf.js'
import {
  BACKUP_FORMAT,
  BACKUP_MANIFEST,
  BACKUP_TABLES,
  INSTANCE_STATE,
  assetEntry,
  backupColumns,
  noteEntry,
  tableEntry,
  trashEntry,
  type Row,
} from './backup-format.js'

export interface ShareManifestEntry {
  granteeType: 'user' | 'team'
  email?: string
  teamName?: string
  permission: 'read' | 'edit'
}

export interface VaultManifest {
  name: string
  mergeable: boolean
  shares: ShareManifestEntry[]
}

/** Builds a vault's manifest: instance metadata, kept out of the note files. */
export async function buildManifest(vaultId: string): Promise<VaultManifest | null> {
  const vault = (await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]
  if (!vault) return null
  const shares = await db.select().from(vaultShares).where(eq(vaultShares.vaultId, vaultId))
  const userIds = shares.filter((s) => s.granteeType === 'user').map((s) => s.granteeId)
  const teamIds = shares.filter((s) => s.granteeType === 'team').map((s) => s.granteeId)
  const userRows = userIds.length
    ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, userIds))
    : []
  const teamRows = teamIds.length
    ? await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds))
    : []
  const emailById = new Map(userRows.map((u) => [u.id, u.email]))
  const teamNameById = new Map(teamRows.map((t) => [t.id, t.name]))
  return {
    name: vault.name,
    mergeable: vault.mergeable,
    shares: shares.map((s) => ({
      granteeType: s.granteeType,
      email: s.granteeType === 'user' ? emailById.get(s.granteeId) : undefined,
      teamName: s.granteeType === 'team' ? teamNameById.get(s.granteeId) : undefined,
      permission: s.permission,
    })),
  }
}

/** Adds a vault's OKF tree + manifest to a zip under the given prefix. */
export async function addVaultToZip(zip: AdmZip, vaultId: string, prefix = ''): Promise<void> {
  const manifest = await buildManifest(vaultId)
  if (!manifest) return
  const rows = await listNotes(vaultId)
  for (const row of rows) {
    const note = await readNote(vaultId, row.path)
    if (!note) continue
    zip.addFile(
      `${prefix}${row.path}.md`,
      Buffer.from(
        serializeNote({ frontmatter: note.frontmatter as Frontmatter, body: note.body }),
        'utf8',
      ),
    )
  }
  const assets = await listAssets(vaultId)
  for (const asset of assets) {
    const data = await readAsset(vaultId, asset.fileName)
    if (data) {
      zip.addFile(`${prefix}assets/${asset.fileName}`, data.buffer)
    }
  }
  zip.addFile(`${prefix}manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
}

export async function buildVaultZip(vaultId: string): Promise<Buffer> {
  const zip = new AdmZip()
  await addVaultToZip(zip, vaultId)
  return zip.toBuffer()
}

/** A file's bytes, or null when it is gone (a note whose file was lost keeps its row). */
async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Full-instance admin backup (format `BACKUP_FORMAT`, see backup-format.ts):
 * every backed-up table as of one database snapshot, plus each note's file
 * (live and trashed, as on disk) and every attachment. Restore: restore.ts.
 */
export async function buildInstanceBackup(): Promise<Buffer> {
  // One snapshot for every table, so a write during the backup can't leave a
  // revision pointing at a note the archive doesn't have.
  const tables = await db.transaction(
    async (tx) => {
      const out = new Map<string, Row[]>()
      for (const spec of [...BACKUP_TABLES, INSTANCE_STATE]) {
        out.set(spec.name, await tx.select(backupColumns(spec)).from(spec.table))
      }
      return out
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )

  const zip = new AdmZip()
  const counts: Record<string, number> = {}
  for (const [name, rows] of tables) {
    counts[name] = rows.length
    // One buffer per row: a single JSON string of every revision could pass V8's string limit.
    zip.addFile(tableEntry(name), Buffer.concat(rows.map((row) => Buffer.from(`${JSON.stringify(row)}\n`, 'utf8'))))
  }
  for (const note of tables.get('notes') ?? []) {
    const vaultId = String(note.vaultId)
    const noteId = String(note.id)
    const trashed = note.deletedAt != null
    const data = await readIfPresent(trashed ? trashFile(vaultId, noteId) : noteFile(vaultId, String(note.path)))
    if (data) zip.addFile(trashed ? trashEntry(vaultId, noteId) : noteEntry(vaultId, String(note.path)), data)
  }
  for (const vault of tables.get('vaults') ?? []) {
    const vaultId = String(vault.id)
    for (const asset of await listAssets(vaultId)) {
      const data = await readAsset(vaultId, asset.fileName)
      if (data) zip.addFile(assetEntry(vaultId, asset.fileName), data.buffer)
    }
  }
  const manifest = { format: BACKUP_FORMAT, createdAt: new Date().toISOString(), tables: counts }
  zip.addFile(BACKUP_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  return zip.toBuffer()
}
