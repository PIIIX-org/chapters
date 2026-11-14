import { beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'
import { db } from '../src/db/client.js'
import { securityEvents, users } from '../src/db/schema.js'
import { holdInstanceLock } from '../src/notes/maintenance-lock.js'
import { createActiveUser, uniqueEmail, wipeInstance } from './helpers.js'

// #813: a database failure during restore reaches the CLI as drizzle's
// DrizzleQueryError, whose message carries the query and its parameters
// (password hashes, TOTP secrets). The CLI prints the Postgres message and
// SQLSTATE from its `cause` only, and a fixed message when the driver error has
// no code. Spawns the CLI (a tsx start of about a second on a CI runner).
describe('restore-backup CLI', { timeout: 60_000 }, () => {
  beforeEach(wipeInstance)

  /** Real CLI process; a fixture-specific data root also bounds refused restores. */
  async function runRestore(archive: Buffer, preload?: string, dataDir?: string): Promise<{ code: unknown; stdout: string; stderr: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'restore-cli-errors-'))
    try {
      const path = join(dir, 'backup.zip')
      await writeFile(path, archive)
      const preloads = preload ? ['--import', preload] : []
      const run = promisify(execFile)(process.execPath, ['--import', 'tsx', ...preloads, 'src/scripts/restore-backup.ts', path], {
        cwd: join(import.meta.dirname, '..'),
        timeout: 20_000,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          ...(dataDir ? { ELARA_DATA_DIR: dataDir, CHAPTERS_DATA_DIR: dataDir, DATA_DIR: dataDir } : {}),
        },
      })
      return await run.then(
        result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
        (error: unknown) => {
          const failure = error as { code?: unknown; stdout?: string; stderr?: string }
          if (failure.code === undefined) throw error
          return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
        },
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** A format-1 archive with one admin per email, each with this password hash. */
  function usersArchive(passwordHash: string, emails: string[]): Buffer {
    const now = new Date().toISOString()
    const dump = {
      users: emails.map((email) => ({ id: randomUUID(), email, passwordHash, status: 'active', role: 'admin', emailVerifiedAt: now, createdAt: now })),
      teams: [],
      teamMemberships: [],
      vaults: [],
      vaultShares: [],
      mcpConnections: [],
      securityEvents: [],
      notifications: [],
    }
    const zip = new AdmZip()
    zip.addFile('account-dump.json', Buffer.from(JSON.stringify(dump), 'utf8'))
    return zip.toBuffer()
  }

  it('prints the Postgres message and SQLSTATE of a wrapped Postgres error, and no query text or parameters', async () => {
    const secret = `secret-hash-${randomUUID()}`
    const email = uniqueEmail('dup')
    // Two users with one email: the users insert fails with 23505.
    const { code, stderr } = await runRestore(usersArchive(secret, [email, email]))
    expect(code).toBe(1)
    expect(stderr).toMatch(/^Restore failed: duplicate key value violates unique constraint "users_email_unique" \(23505\)$/m)
    expect(stderr).not.toContain(secret)
    expect(stderr).not.toMatch(/Failed query|params:|insert into/i)
  })

  it('prints a fixed message, and no query text or parameters, when the wrapped driver error has no code', async () => {
    const secret = `secret-hash-${randomUUID()}`
    const { code, stderr } = await runRestore(usersArchive(secret, [uniqueEmail('codeless')]), './test/fixtures/codeless-users-insert-error.ts')
    expect(code).toBe(1)
    expect(stderr).toMatch(/^Restore failed: a database query failed$/m)
    expect(stderr).not.toContain(secret)
    expect(stderr).not.toMatch(/Failed query|params:|insert into/i)
  })

  it('excludes a live shared instance lease independently of the nonempty-data guard', async () => {
    await createActiveUser()
    const before = await db.select().from(users)
    const dir = await mkdtemp(join(tmpdir(), 'restore-cli-live-'))
    const dataDir = join(dir, 'data')
    await mkdir(dataDir)
    await writeFile(join(dataDir, 'keep.bin'), 'Live instance witness.')
    const lease = await holdInstanceLock('shared')
    try {
      const result = await runRestore(usersArchive('unused-hash', [uniqueEmail('blocked-restore')]), undefined, dataDir)
      expect(result.code).toBe(2)
      expect(result.stderr).toMatch(/^Restore failed: the instance is in use:.*stop it first$/m)
      expect(result.stderr).not.toContain('Refusing to restore:')
      expect(await db.select().from(users)).toEqual(before)
      expect(await db.select().from(securityEvents)).toEqual([])
      expect(await readdir(dataDir)).toEqual(['keep.bin'])
      expect(await readFile(join(dataDir, 'keep.bin'), 'utf8')).toBe('Live instance witness.')
    } finally {
      await lease.release()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('offline CLI restores a fresh instance and independently refuses a different archive once populated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'restore-cli-offline-'))
    const dataDir = join(dir, 'data')
    await mkdir(dataDir)
    await writeFile(join(dataDir, 'keep.bin'), 'Kept volume witness.')
    try {
      const first = await runRestore(usersArchive('restored-hash', [uniqueEmail('offline-restore')]), undefined, dataDir)
      expect(first.code).toBe(0)
      expect(first.stdout).toContain('Restore complete')
      const before = await db.select().from(users)
      expect(before).toHaveLength(1)
      const events = await db.select().from(securityEvents)
      expect(events.map(event => event.type)).toEqual(['instance_restored'])

      const refused = await runRestore(usersArchive('must-not-apply', [uniqueEmail('other-archive')]), undefined, dataDir)
      expect(refused.code).toBe(1)
      expect(refused.stderr).toMatch(/^Refusing to restore: this instance already has 1 user\(s\)/m)
      expect(refused.stderr).not.toContain('the instance is in use')
      expect(await db.select().from(users)).toEqual(before)
      expect(await db.select().from(securityEvents)).toEqual(events)
      expect(await readdir(dataDir)).toEqual(['keep.bin'])
      expect(await readFile(join(dataDir, 'keep.bin'), 'utf8')).toBe('Kept volume witness.')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
