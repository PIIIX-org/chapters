import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { createActiveUser, loginCookie } from './helpers.js'
import { metricsSnapshot } from '../src/monitoring/metrics.js'
import * as archive from '../src/export/archive.js'
import type * as Archive from '../src/export/archive.js'
import { executeBackup, getBackupStatus, startBackupScheduler } from '../src/export/backup-service.js'
import { DrizzleQueryError } from 'drizzle-orm/errors'

// Building the archive (database dump, vault files) fails, not the destination (#771).
vi.mock('../src/export/archive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Archive>()
  return { ...actual, buildInstanceBackup: vi.fn(actual.buildInstanceBackup) }
})

const build = vi.mocked(archive.buildInstanceBackup)
let realBuild: typeof Archive.buildInstanceBackup
const NOTE_PATH = '/data/vaults/0b9e/private/salary-review.md'
function readFailure(): Error {
  return Object.assign(new Error(`EACCES: permission denied, open '${NOTE_PATH}'`), { code: 'EACCES' })
}

let app: FastifyInstance
let adminCookie: string
const testBackupDir = join(process.cwd(), 'scratch/test-backups-771')

beforeAll(async () => {
  realBuild = (await vi.importActual<typeof Archive>('../src/export/archive.js')).buildInstanceBackup
  app = await buildApp()
  await app.ready()
  const admin = await createActiveUser({ role: 'admin' })
  adminCookie = await loginCookie(app, admin.email)
  await rm(testBackupDir, { recursive: true, force: true })
  await mkdir(testBackupDir, { recursive: true })
})

afterAll(async () => {
  await rm(testBackupDir, { recursive: true, force: true })
  await app.close()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  build.mockReset()
  build.mockImplementation(realBuild)
})

describe('a backup whose archive cannot be built (#771)', () => {
  it('records the failure without the note path and waits a full interval before the next scheduled attempt', async () => {
    vi.spyOn(config.backup, 'localPath', 'get').mockReturnValue(testBackupDir)
    vi.spyOn(config.backup, 'intervalHours', 'get').mockReturnValue(1)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const stop = startBackupScheduler()
    try {
      // Pins the schedule: the last run is now, and it worked.
      await executeBackup()
      const pinned = getBackupStatus()
      expect(pinned.lastStatus).toBe('success')
      const files = await readdir(testBackupDir)
      const start = metricsSnapshot().jobs.backup
      const counts = () => {
        const b = metricsSnapshot().jobs.backup
        return { failed: b.failed - start.failed, repeated: b.repeated - start.repeated }
      }

      build.mockRejectedValue(readFailure())
      build.mockClear()
      // Due an hour after the last run: one attempt.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      await vi.waitFor(() => expect(counts()).toEqual({ failed: 1, repeated: 0 }), { interval: 10 })
      expect(build).toHaveBeenCalledTimes(1)

      const status = getBackupStatus()
      expect(status.lastStatus).toBe('error')
      expect(Date.parse(status.lastRunAt!)).toBeGreaterThanOrEqual(Date.parse(pinned.lastRunAt!) + 60 * 60 * 1000)
      expect(status.lastError).toMatch(/backup archive/i)
      expect(status.lastError).toContain('EACCES')
      expect(status.lastError).not.toContain(NOTE_PATH)
      // Monitoring keeps the code, never the message.
      const report = metricsSnapshot().errors.at(-1)
      expect(report).toMatchObject({ type: 'job', job: 'backup', error: { code: 'EACCES' } })
      expect(JSON.stringify(report)).not.toContain(NOTE_PATH)
      // No partial file under a backup name.
      expect(await readdir(testBackupDir)).toEqual(files)

      // The admin page shows the error.
      const res = await app.inject({ method: 'GET', url: '/api/admin/backup/status', headers: { cookie: adminCookie } })
      expect(res.json()).toMatchObject({ lastStatus: 'error', lastError: status.lastError })

      // The 15-minute checks in the next hour don't rebuild the archive.
      for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(build).toHaveBeenCalledTimes(1)

      // A full interval after the failed attempt: one more, a repeat for monitoring.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      await vi.waitFor(() => expect(counts()).toEqual({ failed: 1, repeated: 1 }), { interval: 10 })
      expect(build).toHaveBeenCalledTimes(2)
    } finally {
      stop()
    }
  })

  it('answers POST /api/admin/backup/run with the safe error, records it and logs the cause', async () => {
    vi.spyOn(config.backup, 'localPath', 'get').mockReturnValue(testBackupDir)
    const failure = readFailure()
    build.mockRejectedValue(failure)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.inject({ method: 'POST', url: '/api/admin/backup/run', headers: { cookie: adminCookie } })
    expect(res.statusCode).toBe(500)
    const body = res.json() as { error: string }
    expect(body.error).toMatch(/backup archive/i)
    expect(body.error).not.toContain(NOTE_PATH)
    expect(getBackupStatus()).toMatchObject({ lastStatus: 'error', lastError: body.error })
    // "details in the server log" holds on the on-demand path too.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[backup]'), failure)
  })

  it('reports the SQLSTATE of a database failure wrapped by drizzle', async () => {
    vi.spyOn(config.backup, 'localPath', 'get').mockReturnValue(testBackupDir)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pgError = Object.assign(new Error('permission denied for table users'), { code: '42501' })
    build.mockRejectedValue(new DrizzleQueryError('select "password_hash" from "users"', [], pgError))

    await expect(executeBackup()).rejects.toThrow(/backup archive failed \(42501\)/)
    expect(getBackupStatus().lastError).toContain('42501')
    expect(getBackupStatus().lastError).not.toContain('password_hash')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[backup]'), pgError)
    expect(JSON.stringify(logged.mock.calls.map((args) => args.map(String)))).not.toContain('password_hash')
  })
})
