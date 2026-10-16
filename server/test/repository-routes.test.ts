import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { eq, inArray } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { resolveSyncToken } from '../src/repositories/sync-tokens.js'
import { startLocalWatchers, stopWatchingLocalRepository, reconcileOrphanedSyncs } from '../src/repositories/scheduler.js'
import { listRepositoryFiles } from '../src/repositories/store.js'
import { decryptCredential } from '../src/repositories/credentials.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { scrubStoredGitCredentials } from '../src/repositories/git-remote.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

describe('repository CRUD + shares', () => {
  it('creates each ingestion-method shape and never echoes the credential back', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)

    const git = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: {
        name: 'Git repo',
        ingestionMethod: 'git',
        gitUrl: 'file:///nonexistent.git',
        gitCredential: 'ghp_secret',
      },
    })
    expect(git.statusCode).toBe(200)
    expect(git.body).not.toContain('ghp_secret')
    expect(git.json()).not.toHaveProperty('gitCredentialEncrypted')

    const push = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: { name: 'Push repo', ingestionMethod: 'agent_push' },
    })
    expect(push.statusCode).toBe(200)

    const missingGitUrl = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: { name: 'Bad', ingestionMethod: 'git' },
    })
    expect(missingGitUrl.statusCode).toBe(400)
  })

  // #383: the remote was stored as given, served raw to the owner, and a
  // failed clone could put the authenticated URL into lastSyncError, which
  // every viewer reads.
  it('moves a URL credential into encrypted storage and never serves it, not even after a failed sync', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    // Port 1 refuses the connection, so the first sync fails fast offline.
    const res = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: { name: 'Leaky', ingestionMethod: 'git', gitUrl: 'http://x-access-token:gho_RESTLEAK@127.0.0.1:1/o/r.git' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('gho_RESTLEAK')
    expect(res.json().gitUrl).toBe('http://127.0.0.1:1/o/r.git')
    const id: string = res.json().id

    const [row] = await db.select().from(repositories).where(eq(repositories.id, id))
    expect(row!.gitUrl).toBe('http://127.0.0.1:1/o/r.git')
    expect(decryptCredential(row!.gitCredentialEncrypted!)).toBe('x-access-token:gho_RESTLEAK')

    await expect(syncGitRepository(id)).rejects.toThrow()
    const [failed] = await db.select().from(repositories).where(eq(repositories.id, id))
    expect(failed!.syncStatus).toBe('error')
    expect(failed!.lastSyncError).not.toContain('gho_RESTLEAK')

    const list = await app.inject({ method: 'GET', url: '/api/repositories', headers: { cookie } })
    expect(list.body).toContain('Leaky')
    expect(list.body).not.toContain('gho_RESTLEAK')
  }, 30000)

  it('boot scrub moves credentials out of remotes stored before the fix, and a second run changes nothing', async () => {
    const owner = await createActiveUser()
    const [legacy] = await db
      .insert(repositories)
      .values({
        name: 'legacy',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: 'https://gho_LEGACY@github.com/o/legacy.git',
        lastSyncError: "fatal: unable to access 'https://gho_LEGACY@github.com/o/legacy.git/'",
      })
      .returning()

    await scrubStoredGitCredentials()
    const [scrubbed] = await db.select().from(repositories).where(eq(repositories.id, legacy!.id))
    expect(scrubbed!.gitUrl).toBe('https://github.com/o/legacy.git')
    expect(decryptCredential(scrubbed!.gitCredentialEncrypted!)).toBe('gho_LEGACY')
    expect(scrubbed!.lastSyncError).not.toContain('gho_LEGACY')

    await scrubStoredGitCredentials()
    const [again] = await db.select().from(repositories).where(eq(repositories.id, legacy!.id))
    expect(again).toEqual(scrubbed)
  })

  // #593: with no key the URL must keep its credential (stripping it would
  // break the next sync), but redacting the error text needs no key.
  it('boot scrub with no encryption key still redacts lastSyncError and leaves the remote alone', async () => {
    const owner = await createActiveUser()
    const url = 'https://x-access-token:gho_NOKEYLEGACY@github.com/o/nokey.git'
    // A password of `*` alone: redacting it would grow `***` on every boot.
    const starUrl = 'https://star-user:*@github.com/o/star.git'
    const [legacy, star] = await db
      .insert(repositories)
      .values([
        {
          name: 'legacy-no-key',
          ownerId: owner.id,
          ingestionMethod: 'git',
          gitUrl: url,
          lastSyncError: `fatal: unable to access '${url}/': token gho_NOKEYLEGACY rejected`,
        },
        {
          name: 'legacy-star',
          ownerId: owner.id,
          ingestionMethod: 'git',
          gitUrl: starUrl,
          lastSyncError: `fatal: unable to access '${starUrl}/': password * rejected`,
        },
      ])
      .returning()

    const original = config.credentialsEncryptionKey
    config.credentialsEncryptionKey = undefined
    try {
      const result = await scrubStoredGitCredentials()
      expect(result.skipped).toBeGreaterThan(0)
      const rows = await db.select().from(repositories).where(inArray(repositories.id, [legacy!.id, star!.id]))
      // A second boot finds nothing left to change, on the skipped path too.
      await scrubStoredGitCredentials()
      expect(await db.select().from(repositories).where(inArray(repositories.id, [legacy!.id, star!.id]))).toEqual(rows)
    } finally {
      config.credentialsEncryptionKey = original
    }
    const [row] = await db.select().from(repositories).where(eq(repositories.id, legacy!.id))
    expect(row!.gitUrl).toBe(url)
    expect(row!.gitCredentialEncrypted).toBeNull()
    expect(row!.lastSyncError).toBe("fatal: unable to access 'https://***@github.com/o/nokey.git/': token *** rejected")
    const [starRow] = await db.select().from(repositories).where(eq(repositories.id, star!.id))
    expect(starRow!.lastSyncError).toBe("fatal: unable to access 'https://***@github.com/o/star.git/': password * rejected")
  })

  // Review of #643: a password with an invalid percent sequence (`%zz`, a raw
  // `50%off`) was accepted and stored, ssh:// as given. Decoding it threw: the
  // boot scrub took the server down and a sync stuck the row in `syncing`.
  it('syncs and scrubs remotes whose password holds an invalid percent sequence, ssh and https', async () => {
    const owner = await createActiveUser()
    const remotes = [
      ['ssh://git:%zz-ssh-pw@127.0.0.1:1/o/bad.git', 'ssh://127.0.0.1:1/o/bad.git', 'git:%zz-ssh-pw'],
      ['http://user:50%off-http-pw@127.0.0.1:1/o/bad.git', 'http://127.0.0.1:1/o/bad.git', 'user:50%off-http-pw'],
    ] as const
    const ids: string[] = []
    for (const [url] of remotes) {
      const [row] = await db
        .insert(repositories)
        .values({ name: 'bad-percent', ownerId: owner.id, ingestionMethod: 'git', gitUrl: url })
        .returning()
      ids.push(row!.id)
    }

    // Unscrubbed: the sync clones with the URL's own credential, fails on the
    // refused port and records a redacted error instead of throwing first.
    for (const id of ids) {
      const err: unknown = await syncGitRepository(id).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(URIError)
      const [failed] = await db.select().from(repositories).where(eq(repositories.id, id))
      expect(failed!.syncStatus).toBe('error')
      expect(failed!.lastSyncError).not.toMatch(/ssh-pw|http-pw/)
    }

    await scrubStoredGitCredentials()
    const scrubbed = await db.select().from(repositories).where(inArray(repositories.id, ids))
    for (const [i, [, cleanUrl, credential]] of remotes.entries()) {
      const row = scrubbed.find((r) => r.id === ids[i])!
      expect(row.gitUrl).toBe(cleanUrl)
      expect(decryptCredential(row.gitCredentialEncrypted!)).toBe(credential)
    }
    await scrubStoredGitCredentials()
    expect(await db.select().from(repositories).where(inArray(repositories.id, ids))).toEqual(scrubbed)
  }, 30000)

  it('rejects a local path outside the configured root', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const res = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: { name: 'Escape', ingestionMethod: 'local_path', localPath: '../../etc' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('owner shares, grantee sees it, non-owner cannot manage shares', async () => {
    const owner = await createActiveUser()
    const grantee = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const granteeCookie = await loginCookie(app, grantee.email)

    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie: ownerCookie },
        body: { name: 'Shared', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }

    let list = (
      await app.inject({ method: 'GET', url: '/api/repositories', headers: { cookie: granteeCookie } })
    ).json() as Array<{ id: string; access?: string }>
    expect(list.find((r) => r.id === repo.id)).toBeUndefined()

    const share = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repo.id}/shares`,
      headers: { cookie: ownerCookie },
      body: { granteeType: 'user', granteeId: grantee.id },
    })
    expect(share.statusCode).toBe(200)

    list = (
      await app.inject({ method: 'GET', url: '/api/repositories', headers: { cookie: granteeCookie } })
    ).json() as Array<{ id: string; access: string }>
    expect(list.find((r) => r.id === repo.id)?.access).toBe('viewer')

    const reshare = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repo.id}/shares`,
      headers: { cookie: granteeCookie },
      body: { granteeType: 'user', granteeId: owner.id },
    })
    expect(reshare.statusCode).toBe(404)
  })

  it('graph preference requires current access', async () => {
    const owner = await createActiveUser()
    const stranger = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const strangerCookie = await loginCookie(app, stranger.email)
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie: ownerCookie },
        body: { name: 'Private', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }

    const denied = await app.inject({
      method: 'PUT',
      url: `/api/repositories/${repo.id}/graph-preference`,
      headers: { cookie: strangerCookie },
      body: { include: true },
    })
    expect(denied.statusCode).toBe(404)

    const allowed = await app.inject({
      method: 'PUT',
      url: `/api/repositories/${repo.id}/graph-preference`,
      headers: { cookie: ownerCookie },
      body: { include: true },
    })
    expect(allowed.statusCode).toBe(200)
  })

  it('sync tokens: shown once, owner-only, revoke kills resolution', async () => {
    const owner = await createActiveUser()
    const stranger = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const strangerCookie = await loginCookie(app, stranger.email)
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie: ownerCookie },
        body: { name: 'Tokened', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }

    const denied = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repo.id}/sync-tokens`,
      headers: { cookie: strangerCookie },
    })
    expect(denied.statusCode).toBe(404)

    const created = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repo.id}/sync-tokens`,
      headers: { cookie: ownerCookie },
    })
    expect(created.statusCode).toBe(200)
    const { token } = created.json() as { token: string }
    expect(token).toBeTruthy()

    const listed = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo.id}/sync-tokens`,
      headers: { cookie: ownerCookie },
    })
    expect(JSON.stringify(listed.json())).not.toContain(token)

    const resolved = await resolveSyncToken(token)
    expect(resolved?.repositoryId).toBe(repo.id)

    await app.inject({
      method: 'POST',
      url: `/api/repositories/${repo.id}/sync-tokens/${resolved!.tokenId}/revoke`,
      headers: { cookie: ownerCookie },
    })
    expect(await resolveSyncToken(token)).toBeNull()
  })
})

/**
 * The sync card and the webhook card branch on fields that a 7-column row
 * silently makes `undefined`, which reads as "synced but empty" and "no
 * webhook yet" for a repository that is neither. Every fixture below is
 * seeded away from its column default, so an omitted or hardcoded field
 * cannot pass.
 */
describe('the repository view the sync and webhook cards read', () => {
  it('round-trips every field, with values that differ from the defaults', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const syncedAt = new Date('2026-08-01T10:20:30.000Z')
    const webhookAt = new Date('2026-08-02T11:22:33.000Z')
    const [row] = await db
      .insert(repositories)
      .values({
        name: 'Field carrier',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: 'https://github.com/piiix-org/chapters.git',
        // Deliberately not "main": a hardcoded branch passes on the usual name.
        defaultBranch: 'trunk',
        mergeable: true, // column default is false
        syncStatus: 'error', // column default is idle
        lastSyncedAt: syncedAt,
        lastSyncError: 'fatal: could not read Username',
        lastWebhookAt: webhookAt,
        webhookSecretEncrypted: 'enc:whsec-not-a-real-secret',
      })
      .returning()

    const listed = (
      await app.inject({ method: 'GET', url: '/api/repositories', headers: { cookie } })
    ).json() as Array<Record<string, unknown>>
    const served = listed.find((r) => r.id === row!.id)!
    expect(served).toMatchObject({
      name: 'Field carrier',
      ownerId: owner.id,
      ingestionMethod: 'git',
      gitUrl: 'https://github.com/piiix-org/chapters.git',
      localPath: null,
      defaultBranch: 'trunk',
      mergeable: true,
      syncStatus: 'error',
      lastSyncError: 'fatal: could not read Username',
      webhookConfigured: true,
      access: 'owner',
    })
    expect(new Date(served.lastSyncedAt as string).toISOString()).toBe(syncedAt.toISOString())
    expect(new Date(served.lastWebhookAt as string).toISOString()).toBe(webhookAt.toISOString())
    expect(Number.isFinite(new Date(served.createdAt as string).getTime())).toBe(true)
    // Write-only columns never cross the boundary, not even now that the
    // mapper reads the whole row.
    expect(JSON.stringify(served)).not.toContain('whsec')
    expect(served).not.toHaveProperty('webhookSecretEncrypted')
    expect(served).not.toHaveProperty('gitCredentialEncrypted')

    // PATCH answers with the same view — one mapper, not two that drift.
    const patched = (
      await app.inject({
        method: 'PATCH',
        url: `/api/repositories/${row!.id}`,
        headers: { cookie },
        body: { name: 'Renamed' },
      })
    ).json() as Record<string, unknown>
    expect(patched).toMatchObject({
      name: 'Renamed',
      defaultBranch: 'trunk',
      gitUrl: 'https://github.com/piiix-org/chapters.git',
      lastSyncError: 'fatal: could not read Username',
      webhookConfigured: true,
    })
    expect(new Date(patched.lastWebhookAt as string).toISOString()).toBe(webhookAt.toISOString())
  })

  it('serves an explicit null — not an absent key — for a never-synced local folder', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const [row] = await db
      .insert(repositories)
      .values({
        name: 'Folder',
        ownerId: owner.id,
        ingestionMethod: 'local_path',
        localPath: '/srv/chapters-repos/notes',
      })
      .returning()

    const listed = (
      await app.inject({ method: 'GET', url: '/api/repositories', headers: { cookie } })
    ).json() as Array<Record<string, unknown>>
    const served = listed.find((r) => r.id === row!.id)!
    // `undefined` here is what made syncHealth call this repository
    // "synced, but nothing was indexed". The key must exist and be null.
    for (const key of ['lastSyncedAt', 'lastSyncError', 'lastWebhookAt', 'defaultBranch', 'gitUrl']) {
      expect(served).toHaveProperty(key)
      expect(served[key]).toBeNull()
    }
    expect(served.localPath).toBe('/srv/chapters-repos/notes')
    expect(served.webhookConfigured).toBe(false)
  })

  it('webhookConfigured follows the stored secret, not the owner intent', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie },
        body: { name: 'Hooked', ingestionMethod: 'git', gitUrl: 'file:///nonexistent.git' },
      })
    ).json() as Record<string, unknown>
    // Creating a git repository does not mint a secret, so nothing can verify
    // a delivery yet and the card must not claim otherwise.
    expect(repo.webhookConfigured).toBe(false)

    const minted = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repo.id}/webhook-secret`,
      headers: { cookie },
    })
    expect(minted.statusCode).toBe(200)

    const listed = (
      await app.inject({ method: 'GET', url: '/api/repositories', headers: { cookie } })
    ).json() as Array<Record<string, unknown>>
    expect(listed.find((r) => r.id === repo.id)?.webhookConfigured).toBe(true)
  })
})

/**
 * `startWatching` had no caller in `server/src` at all: nothing started a
 * watcher at boot, nothing started one on create, and the poller filters to
 * `ingestionMethod = 'git'`. A folder repository was therefore connected and
 * then stayed empty forever, while the connect dialog said Chapters was
 * watching it. These tests are the wiring, end to end through the API.
 */
describe('local folder ingestion', () => {
  const dirs: string[] = []

  async function makeFolder(): Promise<{ absolute: string; relative: string }> {
    const root = resolve(config.localReposRoot)
    await mkdir(root, { recursive: true })
    const absolute = await mkdtemp(join(root, 'connect-'))
    dirs.push(absolute)
    return { absolute, relative: absolute.slice(root.length + 1) }
  }

  async function waitForFiles(repositoryId: string, count: number, ms = 4000): Promise<string[]> {
    const start = Date.now()
    for (;;) {
      const files = await listRepositoryFiles(repositoryId)
      if (files.length === count) return files.map((f) => f.path).sort()
      if (Date.now() - start > ms) {
        throw new Error(`expected ${count} files, saw ${files.length}: ${files.map((f) => f.path)}`)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  async function connectFolder(cookie: string, relative: string): Promise<{ id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: { name: 'folder', ingestionMethod: 'local_path', localPath: relative },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as { id: string }
  }

  async function view(cookie: string, id: string): Promise<Record<string, unknown>> {
    const listed = (
      await app.inject({ method: 'GET', url: '/api/repositories', headers: { cookie } })
    ).json() as Array<Record<string, unknown>>
    return listed.find((r) => r.id === id)!
  }

  async function waitForSync(cookie: string, id: string, ms = 4000): Promise<Record<string, unknown>> {
    const start = Date.now()
    for (;;) {
      const served = await view(cookie, id)
      if (served?.lastSyncedAt != null && served?.syncStatus === 'idle') return served
      if (Date.now() - start > ms) return served
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  afterAll(async () => {
    // Every watcher this file opened, including any `startLocalWatchers`
    // attached to another test's repository, or the process never exits.
    const rows = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.ingestionMethod, 'local_path'))
    for (const row of rows) stopWatchingLocalRepository(row.id)
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  })

  it('indexes the folder on connect and reports it synced, not never-synced', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const folder = await makeFolder()
    await writeFile(join(folder.absolute, 'a.ts'), 'export const a = 1\n')
    // Noise the ignore rule must drop — otherwise a count of 1 proves nothing
    // about which file was indexed.
    await mkdir(join(folder.absolute, 'node_modules'))
    await writeFile(join(folder.absolute, 'node_modules', 'dep.ts'), 'export const dep = 2\n')

    const repo = await connectFolder(cookie, folder.relative)
    expect(await waitForFiles(repo.id, 1)).toEqual(['a.ts'])

    const served = await waitForSync(cookie, repo.id)
    // The two states `syncHealth` keeps apart: this is "synced, 1 file", and
    // a null `lastSyncedAt` here would render as "never synced" forever.
    expect(served.lastSyncedAt).not.toBeNull()
    expect(served.syncStatus).toBe('idle')
    expect(served.lastSyncError).toBeNull()
  })

  it('keeps the index current after connect, without another request', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const folder = await makeFolder()
    await writeFile(join(folder.absolute, 'first.ts'), 'export const first = 1\n')

    const repo = await connectFolder(cookie, folder.relative)
    expect(await waitForFiles(repo.id, 1)).toEqual(['first.ts'])

    await writeFile(join(folder.absolute, 'second.ts'), 'export const second = 2\n')
    expect(await waitForFiles(repo.id, 2)).toEqual(['first.ts', 'second.ts'])
  })

  it('re-attaches a watcher at boot to a folder connected before the last restart', async () => {
    const owner = await createActiveUser()
    const folder = await makeFolder()
    await writeFile(join(folder.absolute, 'boot.ts'), 'export const boot = 1\n')
    // Inserted directly: this row is what a restart finds — a repository whose
    // watcher died with the previous process, with nothing to re-create it.
    const [row] = await db
      .insert(repositories)
      .values({
        name: 'pre-existing folder',
        ownerId: owner.id,
        ingestionMethod: 'local_path',
        localPath: folder.absolute,
      })
      .returning()
    expect(await listRepositoryFiles(row!.id)).toEqual([])

    expect(await startLocalWatchers()).toBeGreaterThan(0)
    expect(await waitForFiles(row!.id, 1)).toEqual(['boot.ts'])
  })
})

describe('POST /repositories/:id/sync', () => {
  async function makeAgentRepo(cookie: string): Promise<{ id: string }> {
    return (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie },
        body: { name: 'agent', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }
  }

  it('re-indexes a folder on demand', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const root = resolve(config.localReposRoot)
    await mkdir(root, { recursive: true })
    const dir = await mkdtemp(join(root, 'manual-'))
    try {
      await writeFile(join(dir, 'x.ts'), 'export const x = 1\n')
      // Direct insert, so no watcher exists: the only thing that can index
      // this repository is the endpoint under test.
      const [row] = await db
        .insert(repositories)
        .values({
          name: 'manual',
          ownerId: owner.id,
          ingestionMethod: 'local_path',
          localPath: dir,
        })
        .returning()

      const res = await app.inject({
        method: 'POST',
        url: `/api/repositories/${row!.id}/sync`,
        headers: { cookie },
      })
      expect(res.statusCode).toBe(200)

      const start = Date.now()
      for (;;) {
        const files = await listRepositoryFiles(row!.id)
        if (files.length === 1) {
          expect(files[0]!.path).toBe('x.ts')
          break
        }
        if (Date.now() - start > 4000) throw new Error(`manual sync never indexed the folder`)
        await new Promise((r) => setTimeout(r, 50))
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is owner-only, 409s while a sync is running, and refuses agent-push', async () => {
    const owner = await createActiveUser()
    const stranger = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const strangerCookie = await loginCookie(app, stranger.email)
    const [row] = await db
      .insert(repositories)
      .values({
        name: 'syncable',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: 'file:///nonexistent.git',
        syncStatus: 'syncing',
      })
      .returning()

    // A viewer-or-worse gets the same answer as a bad id, so an id can't be probed.
    const denied = await app.inject({
      method: 'POST',
      url: `/api/repositories/${row!.id}/sync`,
      headers: { cookie: strangerCookie },
    })
    expect(denied.statusCode).toBe(404)

    const busy = await app.inject({
      method: 'POST',
      url: `/api/repositories/${row!.id}/sync`,
      headers: { cookie: ownerCookie },
    })
    expect(busy.statusCode).toBe(409)

    // Same row, same owner — only the status differs, so a 409 that ignored it
    // would still be a 409 here.
    await db.update(repositories).set({ syncStatus: 'idle' }).where(eq(repositories.id, row!.id))
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/repositories/${row!.id}/sync`,
      headers: { cookie: ownerCookie },
    })
    expect(accepted.statusCode).toBe(200)

    // With force=true, an in-flight 'syncing' status can be reclaimed
    await db.update(repositories).set({ syncStatus: 'syncing' }).where(eq(repositories.id, row!.id))
    const forced = await app.inject({
      method: 'POST',
      url: `/api/repositories/${row!.id}/sync?force=true`,
      headers: { cookie: ownerCookie },
    })
    expect(forced.statusCode).toBe(200)

    const agent = await makeAgentRepo(ownerCookie)
    const refused = await app.inject({
      method: 'POST',
      url: `/api/repositories/${agent.id}/sync`,
      headers: { cookie: ownerCookie },
    })
    expect(refused.statusCode).toBe(400)
  })
  it('says which env var is missing instead of a bare Internal Server Error', async () => {
    // Found by clicking "Set up webhook" in a browser. Storing a webhook secret
    // needs CREDENTIALS_ENCRYPTION_KEY, a documented deployment prerequisite —
    // but an uncaught throw reached the owner as the words "Internal Server
    // Error" and nothing else, one env var away from working with no way to
    // know which one.
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie },
        body: { name: 'Keyless', ingestionMethod: 'git', gitUrl: 'file:///nonexistent.git' },
      })
    ).json() as { id: string }

    const original = config.credentialsEncryptionKey
    ;(config as { credentialsEncryptionKey?: string }).credentialsEncryptionKey = undefined
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/repositories/${repo.id}/webhook-secret`,
        headers: { cookie },
      })
      expect(res.statusCode).toBe(409)
      const body = res.json() as { error: string }
      // The name of the thing to set, in the field the client actually renders.
      expect(body.error).toContain('CREDENTIALS_ENCRYPTION_KEY')
      expect(body.error).not.toBe('Internal Server Error')
    } finally {
      ;(config as { credentialsEncryptionKey?: string }).credentialsEncryptionKey = original
    }
  })

  it('reconcileOrphanedSyncs resets stranded syncing repositories to idle if previously synced, or error if never synced', async () => {
    const owner = await createActiveUser()
    const [synced] = await db
      .insert(repositories)
      .values({
        name: 'was-synced',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: 'file:///nonexistent.git',
        syncStatus: 'syncing',
        lastSyncedAt: new Date(),
      })
      .returning()

    const [neverSynced] = await db
      .insert(repositories)
      .values({
        name: 'never-synced',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: 'file:///nonexistent.git',
        syncStatus: 'syncing',
        lastSyncedAt: null,
      })
      .returning()

    const count = await reconcileOrphanedSyncs()
    expect(count).toBeGreaterThanOrEqual(2)

    const [syncedRow] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, synced!.id))
    expect(syncedRow!.syncStatus).toBe('idle')
    expect(syncedRow!.lastSyncError).toBeNull()

    const [neverSyncedRow] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, neverSynced!.id))
    expect(neverSyncedRow!.syncStatus).toBe('error')
    expect(neverSyncedRow!.lastSyncError).toContain('Sync interrupted')
  })
})
