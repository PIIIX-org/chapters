import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import AdmZip from 'adm-zip'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import {
  instanceState,
  mcpConnections,
  notifications,
  securityEvents,
  teamMemberships,
  teams,
  users,
  vaultShares,
  vaults,
} from '../src/db/schema.js'
import { serializeNote } from '../src/notes/okf.js'
import { readNote } from '../src/notes/store.js'
import { isInstanceEmpty, restoreBackup } from '../src/export/restore.js'
import { uniqueEmail } from './helpers.js'

describe('isInstanceEmpty', () => {
  it('returns false once at least one user exists', async () => {
    // Whether the shared test DB already has other tests' rows depends
    // on suite-wide execution order (only true when running the full
    // suite, not this file alone) — create a user here so the check is
    // self-contained regardless of what ran before it.
    await db.insert(users).values({
      email: uniqueEmail('non-empty-check'),
      passwordHash: 'x',
      status: 'active',
    })
    expect(await isInstanceEmpty()).toBe(false)
  })
})

describe('restoreBackup', () => {
  it('recreates every table with original IDs preserved, restores notes, and marks setup complete', async () => {
    const userId = randomUUID()
    const teamId = randomUUID()
    const vaultId = randomUUID()
    const shareId = randomUUID()
    const mcpConnectionId = randomUUID()
    const securityEventId = randomUUID()
    const notificationId = randomUUID()
    const now = new Date().toISOString()

    const dump = {
      users: [
        {
          id: userId,
          email: uniqueEmail('restore'),
          passwordHash: 'argon2-fake-hash-not-reparsed',
          status: 'active',
          role: 'admin',
          emailVerifiedAt: now,
          totpSecret: null,
          mfaEnabledAt: null,
          createdAt: now,
        },
      ],
      teams: [{ id: teamId, name: 'Restored Team', createdAt: now }],
      teamMemberships: [{ teamId, userId, role: 'owner', createdAt: now }],
      vaults: [{ id: vaultId, name: 'Restored Vault', ownerId: userId, mergeable: false, createdAt: now }],
      vaultShares: [
        { id: shareId, vaultId, granteeType: 'team', granteeId: teamId, permission: 'edit', createdAt: now },
      ],
      mcpConnections: [
        {
          id: mcpConnectionId,
          userId,
          name: 'restored-agent',
          scope: 'account',
          vaultId: null,
          repositoryId: null,
          tokenHash: 'unusable-hash',
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: now,
        },
      ],
      securityEvents: [
        { id: securityEventId, type: 'restored_event', actorUserId: userId, subjectUserId: null, mcpConnectionId: null, ip: null, detail: null, createdAt: now },
      ],
      notifications: [
        { id: notificationId, recipientId: userId, type: 'restored', entityType: null, entityId: null, message: 'restored notification', readAt: null, createdAt: now },
      ],
    }

    const zip = new AdmZip()
    zip.addFile('account-dump.json', Buffer.from(JSON.stringify(dump), 'utf8'))
    zip.addFile(
      `vaults/${vaultId}/docs/restored-note.md`,
      Buffer.from(serializeNote({ frontmatter: { type: 'docs' }, body: 'Restored content.' }), 'utf8'),
    )

    const result = await restoreBackup(zip.toBuffer())

    expect(result).toEqual({
      users: 1,
      teams: 1,
      teamMemberships: 1,
      vaults: 1,
      vaultShares: 1,
      mcpConnections: 1,
      securityEvents: 1,
      notifications: 1,
      notesImported: 1,
      notesSkipped: [],
    })

    const restoredUser = (await db.select().from(users).where(eq(users.id, userId)))[0]
    expect(restoredUser?.email).toBe(dump.users[0]!.email)
    expect(restoredUser?.createdAt).toBeInstanceOf(Date)

    expect((await db.select().from(teams).where(eq(teams.id, teamId)))[0]?.name).toBe('Restored Team')
    expect(
      (await db.select().from(teamMemberships).where(eq(teamMemberships.teamId, teamId)))[0]?.userId,
    ).toBe(userId)
    expect((await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]?.ownerId).toBe(userId)
    expect((await db.select().from(vaultShares).where(eq(vaultShares.id, shareId)))[0]?.granteeId).toBe(
      teamId,
    )
    expect(
      (await db.select().from(mcpConnections).where(eq(mcpConnections.id, mcpConnectionId)))[0]?.name,
    ).toBe('restored-agent')
    expect(
      (await db.select().from(securityEvents).where(eq(securityEvents.id, securityEventId)))[0]?.type,
    ).toBe('restored_event')
    expect(
      (await db.select().from(notifications).where(eq(notifications.id, notificationId)))[0]?.message,
    ).toBe('restored notification')

    const note = await readNote(vaultId, 'docs/restored-note')
    expect(note?.body).toBe('Restored content.')

    const state = (await db.select().from(instanceState))[0]
    expect(state?.setupCompletedAt).toBeInstanceOf(Date)
  })

  it('skips a note that fails OKF validation and reports it, without aborting the restore', async () => {
    const userId = randomUUID()
    const vaultId = randomUUID()
    const now = new Date().toISOString()
    const dump = {
      users: [
        {
          id: userId,
          email: uniqueEmail('restore-skip'),
          passwordHash: 'x',
          status: 'active',
          role: 'member',
          emailVerifiedAt: now,
          totpSecret: null,
          mfaEnabledAt: null,
          createdAt: now,
        },
      ],
      teams: [],
      teamMemberships: [],
      vaults: [{ id: vaultId, name: 'Skip Vault', ownerId: userId, mergeable: false, createdAt: now }],
      vaultShares: [],
      mcpConnections: [],
      securityEvents: [],
      notifications: [],
    }
    const zip = new AdmZip()
    zip.addFile('account-dump.json', Buffer.from(JSON.stringify(dump), 'utf8'))
    // Extra path nesting fails the OKF type/name slug convention
    // (splitPath requires exactly one segment of each) — createNote
    // itself forces frontmatter.type to match the path, so a path-shape
    // violation is the failure this loop can actually hit.
    zip.addFile(
      `vaults/${vaultId}/nested/too/deep.md`,
      Buffer.from(serializeNote({ frontmatter: { type: 'nested' }, body: 'x' }), 'utf8'),
    )

    const result = await restoreBackup(zip.toBuffer())
    expect(result.notesImported).toBe(0)
    expect(result.notesSkipped).toHaveLength(1)
    expect(result.notesSkipped[0]).toContain('nested/too/deep')
  })

  it('throws for a zip that is not a full-instance backup', async () => {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from('{}', 'utf8'))
    await expect(restoreBackup(zip.toBuffer())).rejects.toThrow('account-dump.json missing')
  })
})
