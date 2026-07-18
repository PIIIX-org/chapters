import AdmZip from 'adm-zip'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  instanceState,
  mcpConnections,
  notifications,
  securityEvents,
  teamMemberships,
  teams,
  users,
  vaults,
  vaultShares,
} from '../db/schema.js'
import { createNote, splitPath } from '../notes/store.js'
import { parseNote, OkfValidationError } from '../notes/okf.js'

export interface RestoreResult {
  users: number
  teams: number
  teamMemberships: number
  vaults: number
  vaultShares: number
  mcpConnections: number
  securityEvents: number
  notifications: number
  notesImported: number
  notesSkipped: string[]
}

/** Restore refuses to run against anything but a genuinely empty instance. */
export async function isInstanceEmpty(): Promise<boolean> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(users)
  return (row?.count ?? 0) === 0
}

// Produced by buildInstanceBackup()'s own db.select().from(table) calls,
// so structurally these match each table's insert shape once JSON's
// stringified dates are converted back (withDates, below).
interface AccountDump {
  users: Array<typeof users.$inferInsert>
  teams: Array<typeof teams.$inferInsert>
  teamMemberships: Array<typeof teamMemberships.$inferInsert>
  vaults: Array<typeof vaults.$inferInsert>
  vaultShares: Array<typeof vaultShares.$inferInsert>
  mcpConnections: Array<typeof mcpConnections.$inferInsert>
  securityEvents: Array<typeof securityEvents.$inferInsert>
  notifications: Array<typeof notifications.$inferInsert>
}

/** JSON has no Date type — restore every table's timestamp columns back to real Dates. */
function withDates<T extends object>(row: T, fields: (keyof T)[]): T {
  const copy = { ...row }
  for (const field of fields) {
    if (copy[field] != null) copy[field] = new Date(copy[field] as string) as T[typeof field]
  }
  return copy
}

/**
 * Restores a full-instance backup zip (spec 7's "Full-instance admin
 * backup") onto a fresh instance. IDs are preserved from the original
 * dump, not regenerated — this is a restore, not an import; foreign
 * keys across the dump stay intact automatically. Account-layer tables
 * restore inside one transaction; notes restore afterward, per-note
 * best-effort through the same shared OKF-validation write path every
 * other write uses (no restore-specific bypass).
 */
export async function restoreBackup(zipBuffer: Buffer): Promise<RestoreResult> {
  const zip = new AdmZip(zipBuffer)
  const dumpEntry = zip.getEntry('account-dump.json')
  if (!dumpEntry) throw new Error('account-dump.json missing — not a full-instance backup')
  const dump = JSON.parse(dumpEntry.getData().toString('utf8')) as AccountDump

  await db.transaction(async (tx) => {
    if (dump.users.length > 0) {
      await tx.insert(users).values(
        dump.users.map((u) => withDates(u, ['emailVerifiedAt', 'mfaEnabledAt', 'createdAt'])),
      )
    }
    if (dump.teams.length > 0) {
      await tx.insert(teams).values(dump.teams.map((t) => withDates(t, ['createdAt'])))
    }
    if (dump.teamMemberships.length > 0) {
      await tx
        .insert(teamMemberships)
        .values(dump.teamMemberships.map((m) => withDates(m, ['createdAt'])))
    }
    if (dump.vaults.length > 0) {
      await tx.insert(vaults).values(dump.vaults.map((v) => withDates(v, ['createdAt'])))
    }
    if (dump.vaultShares.length > 0) {
      await tx.insert(vaultShares).values(dump.vaultShares.map((s) => withDates(s, ['createdAt'])))
    }
    if (dump.mcpConnections.length > 0) {
      await tx.insert(mcpConnections).values(
        dump.mcpConnections.map((c) =>
          withDates(c, ['expiresAt', 'revokedAt', 'lastUsedAt', 'createdAt']),
        ),
      )
    }
    if (dump.securityEvents.length > 0) {
      await tx
        .insert(securityEvents)
        .values(dump.securityEvents.map((e) => withDates(e, ['createdAt'])))
    }
    if (dump.notifications.length > 0) {
      await tx
        .insert(notifications)
        .values(dump.notifications.map((n) => withDates(n, ['readAt', 'createdAt'])))
    }
    // A fresh instance restoring already-approved users has no reason to
    // repeat the one-time setup-token flow.
    if (dump.users.length > 0) {
      await tx
        .insert(instanceState)
        .values({ setupCompletedAt: new Date() })
        .onConflictDoUpdate({
          target: instanceState.id,
          set: { setupCompletedAt: new Date(), setupTokenHash: null },
        })
    }
  })

  let notesImported = 0
  const notesSkipped: string[] = []
  for (const entry of zip.getEntries()) {
    const match = /^vaults\/([0-9a-f-]+)\/(.+)\.md$/.exec(entry.entryName)
    if (!match) continue
    const [, vaultId, path] = match
    try {
      const { type, name } = splitPath(path!)
      const parsed = parseNote(entry.getData().toString('utf8'))
      const owner = dump.vaults.find((v) => v.id === vaultId)?.ownerId as string | undefined
      await createNote(
        vaultId!,
        { type, name, frontmatter: parsed.frontmatter, body: parsed.body },
        { type: 'user', id: owner },
      )
      notesImported += 1
    } catch (err) {
      if (err instanceof OkfValidationError) notesSkipped.push(`${vaultId}/${path}: ${err.message}`)
      else throw err
    }
  }

  return {
    users: dump.users.length,
    teams: dump.teams.length,
    teamMemberships: dump.teamMemberships.length,
    vaults: dump.vaults.length,
    vaultShares: dump.vaultShares.length,
    mcpConnections: dump.mcpConnections.length,
    securityEvents: dump.securityEvents.length,
    notifications: dump.notifications.length,
    notesImported,
    notesSkipped,
  }
}
