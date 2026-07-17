import AdmZip from 'adm-zip'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  mcpConnections,
  notifications,
  securityEvents,
  teamMemberships,
  teams,
  users,
  vaults,
  vaultShares,
} from '../db/schema.js'
import { listNotes, readNote } from '../notes/store.js'
import { serializeNote, type Frontmatter } from '../notes/okf.js'

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
  zip.addFile(`${prefix}manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
}

export async function buildVaultZip(vaultId: string): Promise<Buffer> {
  const zip = new AdmZip()
  await addVaultToZip(zip, vaultId)
  return zip.toBuffer()
}

/** Full-instance admin backup: every vault bundle + the account layer. */
export async function buildInstanceBackup(): Promise<Buffer> {
  const zip = new AdmZip()
  const allVaults = await db.select({ id: vaults.id }).from(vaults)
  for (const vault of allVaults) {
    await addVaultToZip(zip, vault.id, `vaults/${vault.id}/`)
  }
  const dump = {
    users: await db.select().from(users),
    teams: await db.select().from(teams),
    teamMemberships: await db.select().from(teamMemberships),
    vaults: await db.select().from(vaults),
    vaultShares: await db.select().from(vaultShares),
    // Hashed tokens only — raw secrets are never recoverable (spec 1).
    mcpConnections: await db.select().from(mcpConnections),
    securityEvents: await db.select().from(securityEvents),
    notifications: await db.select().from(notifications),
  }
  zip.addFile('account-dump.json', Buffer.from(JSON.stringify(dump, null, 2), 'utf8'))
  return zip.toBuffer()
}
