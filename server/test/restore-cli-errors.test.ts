import { beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'
import { uniqueEmail, wipeInstance } from './helpers.js'

// #813: a database failure during restore reaches the CLI as drizzle's
// DrizzleQueryError, whose message carries the query and its parameters
// (password hashes, TOTP secrets). The CLI prints the Postgres message and
// SQLSTATE from its `cause` only, and a fixed message when the driver error has
// no code. Spawns the CLI (a tsx start of about a second on a CI runner).
describe('restore-backup CLI: a database failure', { timeout: 60_000 }, () => {
  beforeEach(wipeInstance)

  /** Runs the CLI (after `preload`, if given), which is expected to fail: its exit code and stderr. */
  async function runFailingRestore(archive: Buffer, preload?: string): Promise<{ code: unknown; stderr: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'restore-cli-errors-'))
    try {
      const path = join(dir, 'backup.zip')
      await writeFile(path, archive)
      const preloads = preload ? ['--import', preload] : []
      const run = promisify(execFile)(process.execPath, ['--import', 'tsx', ...preloads, 'src/scripts/restore-backup.ts', path], {
        cwd: join(import.meta.dirname, '..'),
        env: process.env,
      })
      const err = (await run.then(() => null, (e: unknown) => e)) as { code?: unknown; stderr?: string } | null
      if (!err) throw new Error('the restore was expected to fail')
      return { code: err.code, stderr: err.stderr ?? '' }
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
    const { code, stderr } = await runFailingRestore(usersArchive(secret, [email, email]))
    expect(code).toBe(1)
    expect(stderr).toMatch(/^Restore failed: duplicate key value violates unique constraint "users_email_unique" \(23505\)$/m)
    expect(stderr).not.toContain(secret)
    expect(stderr).not.toMatch(/Failed query|params:|insert into/i)
  })

  it('prints a fixed message, and no query text or parameters, when the wrapped driver error has no code', async () => {
    const secret = `secret-hash-${randomUUID()}`
    const { code, stderr } = await runFailingRestore(usersArchive(secret, [uniqueEmail('codeless')]), './test/fixtures/codeless-users-insert-error.ts')
    expect(code).toBe(1)
    expect(stderr).toMatch(/^Restore failed: a database query failed$/m)
    expect(stderr).not.toContain(secret)
    expect(stderr).not.toMatch(/Failed query|params:|insert into/i)
  })
})
