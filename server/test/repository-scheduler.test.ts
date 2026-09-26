import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { shouldPoll, syncLocalRepository } from '../src/repositories/scheduler.js'
import { createActiveUser } from './helpers.js'

const THRESHOLD = 10 * 60 * 1000
const now = new Date('2026-07-18T12:00:00Z')

describe('shouldPoll', () => {
  it('polls when no webhook has ever been seen', () => {
    expect(shouldPoll(null, null, now, THRESHOLD)).toBe(true)
  })

  it('does not poll when a webhook was seen recently', () => {
    const recent = new Date(now.getTime() - 60_000)
    expect(shouldPoll(recent, null, now, THRESHOLD)).toBe(false)
  })

  it('polls when the last webhook is stale and nothing has synced since', () => {
    const stale = new Date(now.getTime() - 20 * 60 * 1000)
    expect(shouldPoll(stale, null, now, THRESHOLD)).toBe(true)
  })

  it('does not poll when a sync already happened more recently than the stale webhook', () => {
    const stale = new Date(now.getTime() - 20 * 60 * 1000)
    const recentSync = new Date(now.getTime() - 60_000)
    expect(shouldPoll(stale, recentSync, now, THRESHOLD)).toBe(false)
  })

  it('polls when the last sync predates the stale webhook', () => {
    const stale = new Date(now.getTime() - 20 * 60 * 1000)
    const oldSync = new Date(now.getTime() - 30 * 60 * 1000)
    expect(shouldPoll(stale, oldSync, now, THRESHOLD)).toBe(true)
  })
})

describe('syncLocalRepository file read failure diagnostics', () => {
  it('logs a warning when a repository file fails to be read during directory scan', async () => {
    const user = await createActiveUser()
    const tempDir = await mkdtemp(join(tmpdir(), 'chapters-repo-test-'))
    await writeFile(join(tempDir, 'file1.txt'), 'hello')
    await writeFile(join(tempDir, 'file2.txt'), 'world')

    const [repo] = await db
      .insert(repositories)
      .values({
        name: 'local-test-repo',
        ownerId: user.id,
        ingestionMethod: 'local_path',
        localPath: tempDir,
      })
      .returning()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await chmod(join(tempDir, 'file2.txt'), 0o000)

    try {
      await syncLocalRepository(repo!.id)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[scheduler] failed reading repository file file2.txt'),
        expect.any(Error),
      )
    } finally {
      await chmod(join(tempDir, 'file2.txt'), 0o644)
      warnSpy.mockRestore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

