import { readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { simpleGit } from 'simple-git'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { decryptCredential } from './credentials.js'
import { listFilesRecursive } from './fs-scan.js'
import { isSafeGitUrl } from './permissions.js'
import { syncRepositoryFiles, type FileUpdate } from './store.js'

const IGNORED = /(^|\/)(\.git|node_modules|\.next|dist|build|\.turbo)(\/|$)/
const MAX_FILE_BYTES = 1_048_576 // 1MB per file limit to prevent heap exhaustion
const MAX_INDEXED_FILES = 10_000

/** Injects a decrypted credential as basic-auth username — the common convention for PATs. */
function authenticatedUrl(gitUrl: string, credential: string | null): string {
  if (!credential) return gitUrl
  try {
    const url = new URL(gitUrl)
    url.username = credential
    return url.toString()
  } catch {
    return gitUrl
  }
}

/**
 * Git URL ingestion (spec 8): a fresh shallow clone (depth 1, no
 * history) into a scratch temp directory on every sync — simpler and
 * more robust than reusing/fetching into a persistent working copy, at
 * the cost of a full re-clone each time. The clone is discarded after
 * its tree is read; only the extracted file content is durable.
 */
export async function syncGitRepository(repositoryId: string): Promise<void> {
  const repo = (await db.select().from(repositories).where(eq(repositories.id, repositoryId)))[0]
  if (!repo || repo.ingestionMethod !== 'git' || !repo.gitUrl) return

  if (!isSafeGitUrl(repo.gitUrl)) {
    await db
      .update(repositories)
      .set({ syncStatus: 'error', lastSyncError: 'Invalid or forbidden git clone URL' })
      .where(eq(repositories.id, repositoryId))
    return
  }

  await db
    .update(repositories)
    .set({ syncStatus: 'syncing' })
    .where(eq(repositories.id, repositoryId))

  const workDir = join(tmpdir(), 'chapters-repo-clones', randomBytes(8).toString('hex'))
  try {
    const credential = repo.gitCredentialEncrypted
      ? decryptCredential(repo.gitCredentialEncrypted)
      : null
    const cloneUrl = authenticatedUrl(repo.gitUrl, credential)

    // ponytail: check remote HEAD commit via ls-remote before expensive full shallow clone (INGEST-05).
    try {
      const lsRemote = await simpleGit({ timeout: { block: 30_000 } }).listRemote([cloneUrl, 'HEAD'])
      const remoteCommit = lsRemote ? lsRemote.trim().split(/\s+/)[0] : null
      if (remoteCommit && repo.lastSyncedCommit && remoteCommit === repo.lastSyncedCommit) {
        await db
          .update(repositories)
          .set({
            syncStatus: 'idle',
            lastSyncedAt: new Date(),
            lastSyncError: null,
          })
          .where(eq(repositories.id, repositoryId))
        return
      }
    } catch (lsErr) {
      console.warn(`[git-sync] listRemote check failed, falling back to clone:`, lsErr)
    }

    await simpleGit({ timeout: { block: 300_000 } }).clone(cloneUrl, workDir, ['--depth', '1'])

    const allPaths = await listFilesRecursive(workDir, IGNORED)
    const currentPaths = allPaths.slice(0, MAX_INDEXED_FILES)
    const files: FileUpdate[] = []
    for (const path of currentPaths) {
      try {
        const fullPath = join(workDir, path)
        const fileStat = await stat(fullPath)
        if (fileStat.size > MAX_FILE_BYTES) {
          continue
        }
        files.push({ path, content: await readFile(fullPath, 'utf8') })
      } catch (err) {
        console.warn(`[git-sync] failed reading ${path}:`, err)
      }
    }
    await syncRepositoryFiles(repositoryId, files, currentPaths)

    // A depth-1 clone checks out the remote's default branch, so the name of
    // the clone's HEAD *is* the default branch — no extra network call.
    const defaultBranch = (await simpleGit(workDir).revparse(['--abbrev-ref', 'HEAD'])).trim()
    const headCommit = (await simpleGit(workDir).revparse(['HEAD'])).trim()

    await db
      .update(repositories)
      .set({
        syncStatus: 'idle',
        lastSyncedAt: new Date(),
        lastSyncError: null,
        defaultBranch,
        lastSyncedCommit: headCommit,
      })
      .where(eq(repositories.id, repositoryId))
  } catch (err) {
    await db
      .update(repositories)
      .set({ syncStatus: 'error', lastSyncError: (err as Error).message })
      .where(eq(repositories.id, repositoryId))
    throw err
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
