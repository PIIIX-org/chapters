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
  const recent = new Date(now.getTime() - 60_000)
  const stale = new Date(now.getTime() - 20 * 60 * 1000)

  it('polls when no webhook has ever been seen', () => {
    expect(shouldPoll(null, 'idle', now, THRESHOLD)).toBe(true)
    expect(shouldPoll(null, 'error', now, THRESHOLD)).toBe(true)
  })

  it('does not poll when a webhook was seen recently and its sync did not fail', () => {
    expect(shouldPoll(recent, 'idle', now, THRESHOLD)).toBe(false)
  })

  // #410: the webhook route writes lastWebhookAt before its sync and the sync
  // writes lastSyncedAt after, so every successful webhook sync leaves
  // lastSyncedAt > lastWebhookAt. A stale webhook must still bring polling back.
  it('polls when the last webhook is stale, even after that webhook synced successfully', () => {
    expect(shouldPoll(stale, 'idle', now, THRESHOLD)).toBe(true)
  })

  it('polls when a recent webhook was followed by a failed sync', () => {
    expect(shouldPoll(recent, 'error', now, THRESHOLD)).toBe(true)
  })

  it('polls when the last webhook is stale and its sync failed', () => {
    expect(shouldPoll(stale, 'error', now, THRESHOLD)).toBe(true)
  })

  it('treats a webhook exactly at the threshold as still fresh', () => {
    const edge = new Date(now.getTime() - THRESHOLD)
    expect(shouldPoll(edge, 'idle', now, THRESHOLD)).toBe(false)
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

