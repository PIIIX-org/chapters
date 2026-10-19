// Instance backup -> wipe -> restore round trip (#409). Every test here wipes
// the whole test database and DATA_DIR/vaults first: a restore only runs on an
// empty instance, and the comparison covers every row of every backed-up table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { readdir, readFile, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import * as OTPAuth from 'otpauth'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { and, eq, sql as dsql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db, sql } from '../src/db/client.js'
import {
  graphPerspectives,
  mcpConnections,
  mfaBackupCodes,
  noteLinks,
  noteRevisions,
  notes,
  notifications,
  repositories,
  repositoryGraphPreferences,
  repositoryShares,
  repositorySyncTokens,
  securityEvents,
  teamMemberships,
  teams,
  userVaultPreferences,
  users,
  vaultGraphPreferences,
  vaultShares,
  vaults,
} from '../src/db/schema.js'
import { buildInstanceBackup } from '../src/export/archive.js'
import { restoreBackup } from '../src/export/restore.js'
import { createNote, saveAsset, softDeleteNote, updateNote } from '../src/notes/store.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createSyncToken, resolveSyncToken } from '../src/repositories/sync-tokens.js'
import { createActiveUser, loginCookie, TEST_PASSWORD, uniqueEmail } from './helpers.js'

/** Every backed-up table, compared row for row (derived columns left out). */
const TABLES: Record<string, PgTable> = {
  users,
  mfaBackupCodes,
  teams,
  teamMemberships,
  vaults,
  vaultShares,
  vaultGraphPreferences,
  userVaultPreferences,
  graphPerspectives,
  repositories,
  repositoryShares,
  repositoryGraphPreferences,
  repositorySyncTokens,
  mcpConnections,
  notifications,
  notes,
  noteRevisions,
  noteLinks,
}

type Snapshot = Record<string, string[]>

async function snapshotDb(): Promise<Snapshot> {
  const out: Snapshot = {}
  for (const [name, table] of Object.entries(TABLES)) {
    const rows = (await db.select().from(table)) as Array<Record<string, unknown>>
    out[name] = rows
      .map((row) => {
        // Embeddings are derived and rebuilt after a restore.
        const { embedding: _embedding, ...rest } = row
        return JSON.stringify(rest)
      })
      .sort()
  }
  return out
}

async function securityEventRows(): Promise<string[]> {
  const rows = await db.select().from(securityEvents)
  return rows.map((row) => JSON.stringify(row)).sort()
}

/** relative path -> sha256 of every file under DATA_DIR/vaults (CRDT state is derived). */
async function snapshotFiles(): Promise<Record<string, string>> {
  const root = join(config.dataDir, 'vaults')
  const out: Record<string, string> = {}
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '.crdt') await walk(full)
      } else {
        out[full.slice(root.length + 1)] = createHash('sha256').update(await readFile(full)).digest('hex')
      }
    }
  }
  await walk(root)
  return out
}

async function wipeInstance(): Promise<void> {
  const tables = await sql<Array<{ tablename: string }>>`select tablename from pg_tables where schemaname = 'public'`
  await sql.unsafe(`truncate ${tables.map((t) => `"${t.tablename}"`).join(', ')} cascade`)
  await rm(join(config.dataDir, 'vaults'), { recursive: true, force: true })
}

async function userCount(): Promise<number> {
  const [row] = await db.select({ n: dsql<number>`count(*)::int` }).from(users)
  return row?.n ?? 0
}

function totpCode(secret: string, email: string): string {
  return new OTPAuth.TOTP({ issuer: 'Elara', label: email, secret: OTPAuth.Secret.fromBase32(secret) }).generate()
}

function stringField(body: unknown, key: string): string {
  const value: unknown = body !== null && typeof body === 'object' ? Reflect.get(body, key) : undefined
  if (typeof value !== 'string') throw new Error(`response has no string "${key}": ${JSON.stringify(body)}`)
  return value
}

let app: FastifyInstance
let baseUrl: string
const clients: Client[] = []

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'backup-roundtrip', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

interface Fixture {
  vaultId: string
  trashedVaultId: string
  repoId: string
  trashedNoteId: string
  assetName: string
  assetBytes: Buffer
  repoToken: string
  syncToken: string
  mfaEmail: string
  mfaSecret: string
  mfaBackupCode: string
}

/** A realistic instance: trash, revisions, attachments, repositories, pinned tokens, MFA. */
async function buildFixture(): Promise<Fixture> {
  const owner = await createActiveUser({ role: 'admin' })
  const member = await createActiveUser()
  const ownerCookie = await loginCookie(app, owner.email)
  const actor = { type: 'user' as const, id: owner.id }

  const [vault] = await db.insert(vaults).values({ name: 'Source', ownerId: owner.id }).returning()
  const vaultId = vault!.id
  const assetBytes = randomBytes(2048)
  const asset = await saveAsset(vaultId, 'diagram.png', assetBytes)
  await createNote(
    vaultId,
    {
      path: 'concepts/linked',
      frontmatter: { type: 'concepts', title: 'Linked', tags: ['a', 'b'] },
      body: `[[concepts/edited]] ![d](/api/vaults/${vaultId}/assets/${asset.fileName})\n`,
    },
    actor,
  )
  await createNote(vaultId, { path: 'concepts/deep/a/b/leaf', frontmatter: { type: 'concepts' }, body: 'leaf\n' }, actor)
  await createNote(vaultId, { path: 'concepts/edited', frontmatter: { type: 'concepts' }, body: 'one\n' }, actor)
  await updateNote(vaultId, 'concepts/edited', { body: 'two\n' }, actor)
  await updateNote(vaultId, 'concepts/edited', { body: 'three\n' }, { type: 'mcp', id: owner.id })
  const trashed = await createNote(vaultId, { path: 'concepts/trashed', frontmatter: { type: 'concepts' }, body: 'bin\n' }, actor)
  await softDeleteNote(vaultId, 'concepts/trashed', actor)

  const [trashedVault] = await db.insert(vaults).values({ name: 'Binned', ownerId: owner.id }).returning()
  await createNote(trashedVault!.id, { path: 'concepts/inside', frontmatter: { type: 'concepts' }, body: 'x\n' }, actor)
  const binned = await app.inject({ method: 'DELETE', url: `/api/vaults/${trashedVault!.id}`, headers: { cookie: ownerCookie } })
  expect(binned.statusCode).toBeLessThan(300)

  const [team] = await db.insert(teams).values({ name: 'Team' }).returning()
  await db.insert(teamMemberships).values({ teamId: team!.id, userId: member.id, role: 'member' })
  await db.insert(vaultShares).values([
    { vaultId, granteeType: 'user', granteeId: member.id, permission: 'read' },
    { vaultId, granteeType: 'team', granteeId: team!.id, permission: 'edit' },
  ])
  await db.insert(vaultGraphPreferences).values({ userId: owner.id, vaultId, include: true })
  await db.insert(userVaultPreferences).values({ userId: owner.id, favorites: { [vaultId]: true } })
  await db.insert(graphPerspectives).values({ vaultId, userId: owner.id, name: 'Concepts', filters: { types: ['concepts'] } })
  await db.insert(notifications).values({ recipientId: member.id, type: 'share', message: 'shared with you' })

  const repo = await app.inject({
    method: 'POST',
    url: '/api/repositories',
    headers: { cookie: ownerCookie },
    body: { name: 'pinned-repo', ingestionMethod: 'agent_push' },
  })
  expect(repo.statusCode).toBeLessThan(300)
  const repoId = stringField(repo.json(), 'id')
  await db.insert(repositoryShares).values({ repositoryId: repoId, granteeType: 'user', granteeId: member.id })
  await db.insert(repositoryGraphPreferences).values({ userId: owner.id, repositoryId: repoId, include: true })
  const syncToken = await createSyncToken(repoId)
  const repoTokenRes = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie: ownerCookie },
    body: { name: 'repo-agent', scope: 'repository', repositoryId: repoId },
  })
  expect(repoTokenRes.statusCode).toBeLessThan(300)
  const capped = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie: ownerCookie },
    body: {
      name: 'capped',
      scope: 'vault',
      vaultId,
      access: 'read',
      allowedTools: ['read_note'],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  })
  expect(capped.statusCode).toBeLessThan(300)

  const mfaUser = await createActiveUser({ email: uniqueEmail('mfa') })
  const mfaCookie = await loginCookie(app, mfaUser.email)
  const setup = await app.inject({ method: 'POST', url: '/api/mfa/setup', headers: { cookie: mfaCookie } })
  const mfaSecret = stringField(setup.json(), 'secret')
  const enable = await app.inject({
    method: 'POST',
    url: '/api/mfa/enable',
    headers: { cookie: mfaCookie },
    body: { code: totpCode(mfaSecret, mfaUser.email) },
  })
  expect(enable.statusCode).toBe(200)
  const backupCodes: unknown = Reflect.get(enable.json() ?? {}, 'backupCodes')
  if (!Array.isArray(backupCodes) || typeof backupCodes[0] !== 'string') throw new Error('no backup codes')

  await flushEmbeddings()
  return {
    vaultId,
    trashedVaultId: trashedVault!.id,
    repoId,
    trashedNoteId: trashed.id,
    assetName: asset.fileName,
    assetBytes,
    repoToken: stringField(repoTokenRes.json(), 'token'),
    syncToken,
    mfaEmail: mfaUser.email,
    mfaSecret,
    mfaBackupCode: backupCodes[0],
  }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()))
  await app.close()
})

describe('instance backup round trip (#409)', () => {
  let fixture: Fixture
  let archive: Buffer
  let source: Snapshot
  let sourceFiles: Record<string, string>
  let sourceEvents: string[]

  it('restores every entity class with its ids after a wipe', async () => {
    await wipeInstance()
    fixture = await buildFixture()
    source = await snapshotDb()
    sourceFiles = await snapshotFiles()
    sourceEvents = await securityEventRows()
    archive = await buildInstanceBackup()

    await wipeInstance()
    expect(await userCount()).toBe(0)
    await restoreBackup(archive)

    const restored = await snapshotDb()
    for (const name of Object.keys(TABLES)) {
      expect({ table: name, rows: restored[name] }).toEqual({ table: name, rows: source[name] })
    }
    expect(source.noteRevisions!.length).toBeGreaterThanOrEqual(7)
    expect(await snapshotFiles()).toEqual(sourceFiles)
    // The archive's audit log is back, plus one event recording the restore.
    const events = await securityEventRows()
    expect(events.filter((e) => !sourceEvents.includes(e)).map((e) => JSON.parse(e).type)).toEqual(['instance_restored'])
    expect(sourceEvents.every((e) => events.includes(e))).toBe(true)
  })

  it('keeps the trashed vault and the trashed note in the trash', async () => {
    const [vault] = await db.select().from(vaults).where(eq(vaults.id, fixture.trashedVaultId))
    expect(vault?.deletedAt).toBeInstanceOf(Date)
    const [note] = await db.select().from(notes).where(eq(notes.id, fixture.trashedNoteId))
    expect(note?.deletedAt).toBeInstanceOf(Date)
    const trashFile = await readFile(join(config.dataDir, 'vaults', fixture.vaultId, '.trash', `${fixture.trashedNoteId}.md`), 'utf8')
    expect(trashFile).toContain('bin')
  })

  it('restores attachment bytes, a working TOTP and backup codes, and working tokens', async () => {
    const assetRes = await app.inject({
      method: 'GET',
      url: `/api/vaults/${fixture.vaultId}/assets/${fixture.assetName}`,
      headers: { cookie: await loginCookie(app, (await db.select().from(users).where(eq(users.role, 'admin')))[0]!.email) },
    })
    expect(assetRes.statusCode).toBe(200)
    expect(Buffer.from(assetRes.rawPayload).equals(fixture.assetBytes)).toBe(true)

    const totpLogin = await app.inject({
      method: 'POST',
      url: '/api/login',
      body: { email: fixture.mfaEmail, password: TEST_PASSWORD, totp: totpCode(fixture.mfaSecret, fixture.mfaEmail) },
    })
    expect(totpLogin.statusCode).toBe(200)
    const codeLogin = await app.inject({
      method: 'POST',
      url: '/api/login',
      body: { email: fixture.mfaEmail, password: TEST_PASSWORD, totp: fixture.mfaBackupCode },
    })
    expect(codeLogin.statusCode).toBe(200)

    const scoped = await mcpClient(fixture.repoToken)
    const browse = await scoped.callTool({ name: 'browse_repository', arguments: {} })
    expect(browse.isError).toBeFalsy()
    expect(await resolveSyncToken(fixture.syncToken)).toMatchObject({ repositoryId: fixture.repoId })
  })

  it('is a no-op when run again on the same archive', async () => {
    const before = await snapshotDb()
    const beforeFiles = await snapshotFiles()
    const beforeEvents = await securityEventRows()
    await restoreBackup(archive)
    expect(await snapshotDb()).toEqual(before)
    expect(await snapshotFiles()).toEqual(beforeFiles)
    expect(await securityEventRows()).toEqual(beforeEvents)
  })

  it('fills in only what is missing when some rows and files are already there', async () => {
    const before = await snapshotDb()
    const beforeFiles = await snapshotFiles()
    const [revision] = await db.select().from(noteRevisions).limit(1)
    await db.delete(noteRevisions).where(eq(noteRevisions.id, revision!.id))
    await db
      .delete(vaultShares)
      .where(and(eq(vaultShares.vaultId, fixture.vaultId), eq(vaultShares.granteeType, 'team')))
    await unlink(join(config.dataDir, 'vaults', fixture.vaultId, 'assets', fixture.assetName))

    await restoreBackup(archive)
    expect(await snapshotDb()).toEqual(before)
    expect(await snapshotFiles()).toEqual(beforeFiles)
  })

  it('refuses an instance that holds data from somewhere else, writing nothing', async () => {
    await wipeInstance()
    await createActiveUser()
    await expect(restoreBackup(archive)).rejects.toThrow(/already has/)
    expect(await userCount()).toBe(1)
    expect(await db.select().from(vaults)).toHaveLength(0)
    expect(await snapshotFiles()).toEqual({})
  })

  it('rejects a corrupted archive before writing anything', async () => {
    const corruptions: Array<[string, () => Buffer]> = [
      ['truncated zip', () => archive.subarray(0, Math.floor(archive.length / 2))],
      [
        'missing table',
        () => {
          const zip = new AdmZip(archive)
          zip.deleteFile('db/users.jsonl')
          return zip.toBuffer()
        },
      ],
      [
        'revision of a note the archive lacks',
        () => {
          const zip = new AdmZip(archive)
          const lines = zip.getEntry('db/note_revisions.jsonl')!.getData().toString('utf8').trim().split('\n')
          const broken = { ...JSON.parse(lines[0]!), noteId: '00000000-0000-4000-8000-000000000000' }
          zip.updateFile('db/note_revisions.jsonl', Buffer.from([JSON.stringify(broken), ...lines.slice(1)].join('\n') + '\n'))
          return zip.toBuffer()
        },
      ],
    ]
    for (const [label, corrupt] of corruptions) {
      await wipeInstance()
      let bad: Buffer
      try {
        bad = corrupt()
      } catch (err) {
        throw new Error(`${label}: could not build the corrupted archive: ${String(err)}`)
      }
      await expect(restoreBackup(bad), label).rejects.toThrow()
      expect(await userCount(), label).toBe(0)
      expect(await snapshotFiles(), label).toEqual({})
    }
  })
})
