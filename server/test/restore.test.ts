import { beforeEach, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import {
  instanceState,
  mcpConnections,
  noteRevisions,
  notes,
  notifications,
  securityEvents,
  teamMemberships,
  teams,
  users,
  vaultShares,
  vaults,
} from '../src/db/schema.js'
import { buildInstanceBackup } from '../src/export/archive.js'
import { BackupInvalidError, restoreBackup } from '../src/export/restore.js'
import { serializeNote } from '../src/notes/okf.js'
import { assetFile, readNote } from '../src/notes/store.js'
import { uniqueEmail, wipeInstance } from './helpers.js'

const now = new Date().toISOString()

function user(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    email: uniqueEmail('restore'),
    passwordHash: 'argon2-fake-hash-not-reparsed',
    status: 'active',
    role: 'admin',
    emailVerifiedAt: now,
    totpSecret: null,
    mfaEnabledAt: null,
    createdAt: now,
    ...overrides,
  }
}

function connection(id: string, userId: string, scope: 'account' | 'vault' | 'repository', pin: string | null = null) {
  return {
    id,
    userId,
    name: `restored-${id}`,
    scope,
    vaultId: scope === 'vault' ? pin : null,
    repositoryId: scope === 'repository' ? pin : null,
    tokenHash: `unusable-${id}`,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: now,
  }
}

/** A format-1 archive: what `buildInstanceBackup` wrote before #409. */
function legacyArchive(dump: Record<string, unknown>, files: Record<string, Buffer | string> = {}): Buffer {
  const zip = new AdmZip()
  const full = {
    users: [],
    teams: [],
    teamMemberships: [],
    vaults: [],
    vaultShares: [],
    mcpConnections: [],
    securityEvents: [],
    notifications: [],
    ...dump,
  }
  zip.addFile('account-dump.json', Buffer.from(JSON.stringify(full), 'utf8'))
  for (const [name, data] of Object.entries(files)) zip.addFile(name, Buffer.from(data))
  return zip.toBuffer()
}

beforeEach(wipeInstance)

describe('restoreBackup: format-1 archives (account-dump.json)', () => {
  it('restores every table with its ids, a trashed vault as trashed, notes and attachments, and marks setup complete', async () => {
    const userId = randomUUID()
    const teamId = randomUUID()
    const vaultId = randomUUID()
    const binnedId = randomUUID()
    const shareId = randomUUID()
    const asset = randomBytes(64)
    const archive = legacyArchive(
      {
        users: [user(userId)],
        teams: [{ id: teamId, name: 'Restored Team', createdAt: now }],
        teamMemberships: [{ teamId, userId, role: 'owner', createdAt: now }],
        vaults: [
          { id: vaultId, name: 'Restored Vault', ownerId: userId, mergeable: false, createdAt: now, deletedAt: null },
          { id: binnedId, name: 'Binned', ownerId: userId, mergeable: false, createdAt: now, deletedAt: now },
        ],
        vaultShares: [{ id: shareId, vaultId, granteeType: 'team', granteeId: teamId, permission: 'edit', createdAt: now }],
        mcpConnections: [connection(randomUUID(), userId, 'account')],
        securityEvents: [{ id: randomUUID(), type: 'restored_event', actorUserId: userId, subjectUserId: null, mcpConnectionId: null, ip: null, detail: null, createdAt: now }],
        notifications: [{ id: randomUUID(), recipientId: userId, type: 'restored', entityType: null, entityId: null, message: 'restored notification', readAt: null, createdAt: now }],
      },
      {
        [`vaults/${vaultId}/docs/restored-note.md`]: serializeNote({ frontmatter: { type: 'docs' }, body: 'Restored content.' }),
        [`vaults/${vaultId}/manifest.json`]: '{}',
        [`vaults/${vaultId}/assets/diagram-1-abc.png`]: asset,
        [`vaults/${binnedId}/docs/inside.md`]: serializeNote({ frontmatter: { type: 'docs' }, body: 'x' }),
      },
    )

    const plan = await restoreBackup(archive)
    expect(plan.format).toBe(1)
    expect(plan.conflicts).toEqual([])
    expect(plan.tables.find((t) => t.table === 'users')).toEqual({ table: 'users', inArchive: 1, toRestore: 1, present: 0 })
    expect(plan.files).toEqual([
      { kind: 'notes', inArchive: 2, toWrite: 2, present: 0 },
      { kind: 'trash', inArchive: 0, toWrite: 0, present: 0 },
      { kind: 'attachments', inArchive: 1, toWrite: 1, present: 0 },
    ])

    expect((await db.select().from(users).where(eq(users.id, userId)))[0]?.createdAt).toBeInstanceOf(Date)
    expect((await db.select().from(teams).where(eq(teams.id, teamId)))[0]?.name).toBe('Restored Team')
    expect((await db.select().from(teamMemberships).where(eq(teamMemberships.teamId, teamId)))[0]?.userId).toBe(userId)
    expect((await db.select().from(vaults).where(eq(vaults.id, binnedId)))[0]?.deletedAt).toEqual(new Date(now))
    expect((await db.select().from(vaultShares).where(eq(vaultShares.id, shareId)))[0]?.granteeId).toBe(teamId)
    expect(await db.select().from(mcpConnections)).toHaveLength(1)
    expect((await db.select().from(securityEvents)).map((e) => e.type).sort()).toEqual(['instance_restored', 'restored_event'])
    expect(await db.select().from(notifications)).toHaveLength(1)

    const note = await readNote(vaultId, 'docs/restored-note')
    expect(note?.body).toBe('Restored content.')
    expect(await db.select().from(noteRevisions).where(eq(noteRevisions.noteId, note!.row.id))).toHaveLength(1)
    expect((await readFile(assetFile(vaultId, 'diagram-1-abc.png'))).equals(asset)).toBe(true)
    expect((await db.select().from(instanceState))[0]?.setupCompletedAt).toBeInstanceOf(Date)
  })

  it('gives notes the same ids on a re-run, so nothing is duplicated', async () => {
    const userId = randomUUID()
    const vaultId = randomUUID()
    const archive = legacyArchive(
      {
        users: [user(userId)],
        vaults: [{ id: vaultId, name: 'V', ownerId: userId, mergeable: false, createdAt: now }],
      },
      { [`vaults/${vaultId}/docs/a.md`]: serializeNote({ frontmatter: { type: 'docs' }, body: 'a' }) },
    )
    await restoreBackup(archive)
    const first = await db.select({ id: notes.id }).from(notes)
    const again = await restoreBackup(archive)
    expect(again.rerun).toBe(true)
    expect(again.tables.every((t) => t.toRestore === 0)).toBe(true)
    expect(await db.select({ id: notes.id }).from(notes)).toEqual(first)
    expect(await db.select().from(noteRevisions)).toHaveLength(1)
  })

  it("restores a pre-0019 dump with account tokens at admin and pinned tokens at write, and keeps a newer dump's capabilities", async () => {
    const userId = randomUUID()
    const vaultId = randomUUID()
    const [accountId, pinnedId, limitedId] = [randomUUID(), randomUUID(), randomUUID()]
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString()
    await restoreBackup(
      legacyArchive({
        users: [user(userId, { role: 'member' })],
        vaults: [{ id: vaultId, name: 'Capabilities Vault', ownerId: userId, mergeable: false, createdAt: now }],
        // The first two rows predate migration 0019: no access or allowedTools field.
        mcpConnections: [
          connection(accountId, userId, 'account'),
          connection(pinnedId, userId, 'vault', vaultId),
          { ...connection(limitedId, userId, 'vault', vaultId), access: 'read', allowedTools: ['read_note'], expiresAt },
        ],
      }),
    )
    const byId = new Map((await db.select().from(mcpConnections)).map((c) => [c.id, c]))
    expect(byId.get(accountId)).toMatchObject({ access: 'admin', allowedTools: null, expiresAt: null })
    expect(byId.get(pinnedId)).toMatchObject({ access: 'write', allowedTools: null, expiresAt: null })
    expect(byId.get(limitedId)).toMatchObject({ access: 'read', allowedTools: ['read_note'], expiresAt: new Date(expiresAt) })
  })

  it('leaves out tokens pinned to a repository the archive lacks, and says so', async () => {
    const userId = randomUUID()
    const kept = randomUUID()
    const plan = await restoreBackup(
      legacyArchive({
        users: [user(userId, { mfaEnabledAt: now })],
        mcpConnections: [connection(kept, userId, 'account'), connection(randomUUID(), userId, 'repository', randomUUID())],
      }),
    )
    expect((await db.select().from(mcpConnections)).map((c) => c.id)).toEqual([kept])
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('1 repository-scoped MCP token(s) left out'), expect.stringContaining('1 user(s) have MFA on')]),
    )
  })

  it('skips a note that fails OKF validation and reports it, without aborting the restore', async () => {
    const userId = randomUUID()
    const vaultId = randomUUID()
    const plan = await restoreBackup(
      legacyArchive(
        { users: [user(userId)], vaults: [{ id: vaultId, name: 'Skip', ownerId: userId, mergeable: false, createdAt: now }] },
        // Deeper than 8 segments fails OKF validation.
        { [`vaults/${vaultId}/1/2/3/4/5/6/7/8/9.md`]: serializeNote({ frontmatter: { type: '1' }, body: 'x' }) },
      ),
    )
    expect(await db.select().from(notes)).toHaveLength(0)
    expect(plan.warnings.some((w) => w.includes('1/2/3/4/5/6/7/8/9'))).toBe(true)
  })

  it('restores nested notes (3-8 segments)', async () => {
    const userId = randomUUID()
    const vaultId = randomUUID()
    await restoreBackup(
      legacyArchive(
        { users: [user(userId)], vaults: [{ id: vaultId, name: 'Nested', ownerId: userId, mergeable: false, createdAt: now }] },
        {
          [`vaults/${vaultId}/domains/auth/session.md`]: serializeNote({
            frontmatter: { type: 'domains', title: 'User Session', status: 'active' },
            body: 'Hierarchical note body.',
          }),
          [`vaults/${vaultId}/a/b/c/d/e/f/g/h.md`]: serializeNote({ frontmatter: { type: 'a' }, body: 'Max depth note body.' }),
        },
      ),
    )
    const note1 = await readNote(vaultId, 'domains/auth/session')
    expect(note1?.body).toBe('Hierarchical note body.')
    expect(note1?.frontmatter.title).toBe('User Session')
    expect((await readNote(vaultId, 'a/b/c/d/e/f/g/h'))?.body).toBe('Max depth note body.')
  })
})

describe('restoreBackup: validate and plan', () => {
  it('writes nothing on a dry run and reports what it would do', async () => {
    const userId = randomUUID()
    const plan = await restoreBackup(legacyArchive({ users: [user(userId)] }), { dryRun: true })
    expect(plan.tables.find((t) => t.table === 'users')?.toRestore).toBe(1)
    expect(await db.select().from(users)).toHaveLength(0)
    expect(await db.select().from(securityEvents)).toHaveLength(0)
  })

  it('never puts a secret, hash or note body in the plan', async () => {
    const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
    const [owner] = await db
      .insert(users)
      .values({ email: uniqueEmail('secret'), passwordHash: 'pw-hash-secret', status: 'active', totpSecret, mfaEnabledAt: new Date() })
      .returning()
    await db.insert(mcpConnections).values({ userId: owner!.id, name: 't', scope: 'account', access: 'admin', tokenHash: 'token-hash-secret' })
    const archive = await buildInstanceBackup()
    await wipeInstance()
    const plan = JSON.stringify(await restoreBackup(archive, { dryRun: true }))
    for (const secret of [totpSecret, 'pw-hash-secret', 'token-hash-secret', owner!.email]) expect(plan).not.toContain(secret)
  })

  it('refuses an archive made by a newer format', async () => {
    const zip = new AdmZip()
    zip.addFile('backup.json', Buffer.from(JSON.stringify({ format: 99, tables: {} }), 'utf8'))
    await expect(restoreBackup(zip.toBuffer())).rejects.toThrow(/format 99, made by a newer Elara/)
  })

  it('refuses a zip that is not an instance backup', async () => {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from('{}', 'utf8'))
    await expect(restoreBackup(zip.toBuffer())).rejects.toThrow(BackupInvalidError)
  })
})
