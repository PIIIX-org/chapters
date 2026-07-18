import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { simpleGit } from 'simple-git'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { decryptCredential } from './credentials.js'
import { listFilesRecursive } from './fs-scan.js'
import { syncRepositoryFiles, type FileUpdate } from './store.js'

const IGNORED = /(^|\/)\.git(\/|$)/

/** Injects a decrypted credential as basic-auth username — the common convention for PATs. */
function authenticatedUrl(gitUrl: string, credential: string | null): string {
  if (!credential) return gitUrl
  const url = new URL(gitUrl)
  url.username = credential
  return url.toString()
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
    await simpleGit().clone(cloneUrl, workDir, ['--depth', '1'])

    const currentPaths = await listFilesRecursive(workDir, IGNORED)
    const files: FileUpdate[] = []
    for (const path of currentPaths) {
      files.push({ path, content: await readFile(join(workDir, path), 'utf8') })
    }
    await syncRepositoryFiles(repositoryId, files, currentPaths)

    await db
      .update(repositories)
      .set({ syncStatus: 'idle', lastSyncedAt: new Date(), lastSyncError: null })
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
