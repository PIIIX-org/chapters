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
import { authenticatedUrl, redactGitSecrets } from './git-remote.js'
import { isSafeGitUrl } from './permissions.js'
import { syncRepositoryFiles, type FileUpdate } from './store.js'

const IGNORED = /(^|\/)(\.git|node_modules|\.next|dist|build|\.turbo)(\/|$)/
const MAX_FILE_BYTES = 1_048_576 // 1MB per file limit to prevent heap exhaustion
const MAX_INDEXED_FILES = 10_000

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

  const workDir = join(tmpdir(), 'elara-repo-clones', randomBytes(8).toString('hex'))
  let credential: string | null = null
  try {
    credential = repo.gitCredentialEncrypted
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
      // git errors can echo the authenticated clone URL (#383).
      const detail = lsErr instanceof Error ? lsErr.message : String(lsErr)
      console.warn(`[git-sync] listRemote check failed, falling back to clone: ${redactGitSecrets(detail, [credential])}`)
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
        const content = await readFile(fullPath, 'utf8')
        if (content.includes('\0')) {
          continue
        }
        files.push({ path, content })
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
    // The raw message can carry the authenticated clone URL, and lastSyncError
    // is served to every viewer: store and rethrow only the redacted text (#383).
    const raw = err instanceof Error ? err.message : String(err)
    const errorMsg = redactGitSecrets(raw, [credential]).replace(/\0/g, '')
    await db
      .update(repositories)
      .set({ syncStatus: 'error', lastSyncError: errorMsg })
      .where(eq(repositories.id, repositoryId))
    throw new Error(errorMsg)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
