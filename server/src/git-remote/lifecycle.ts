import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { vaultGitSnapshots } from '../db/schema.js'
import { withKeyLock } from '../notes/key-lock.js'

export const vaultRemotesRoot = (): string => join(config.dataDir, 'git-remotes')
export const vaultRemoteDir = (vaultId: string): string => join(vaultRemotesRoot(), `${vaultId}.git`)

/** One barrier for uploads, imports, exports and explicit purges; a purge waits for in-flight reads, never races Git GC. */
export function withVaultGit<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`vault-git:${vaultId}`, fn)
}

/**
 * Call UNDER withVaultGit, BEFORE purging authoritative content. On an IO failure the purge must not proceed.
 * Remove the entire object database (reachable, unreachable and reflogs), not just the current ref.
 * A subsequent read rebuilds only current content. Existing external clones/exports cannot be erased by the server.
 */
export async function invalidateVaultGit(vaultId: string): Promise<void> {
  await rm(vaultRemoteDir(vaultId), { recursive: true, force: true })
  await db.delete(vaultGitSnapshots).where(eq(vaultGitSnapshots.vaultId, vaultId))
  // These are content-bearing caches, unlike session passage hashes or embedding vectors.
  // Preserve hashes/effect receipts: dropping a key would let a network retry resurrect a purged write.
  await db.execute(sql`UPDATE write_idempotency SET result = jsonb_build_object(
    'rev', NULL, 'status', 'conflicted', 'indexed', false, 'purged', true,
    'message', 'the recorded result was purged; this idempotency key will not apply again within its original window')
    WHERE note_id IN (SELECT id FROM notes WHERE vault_id = ${vaultId})`)
  await db.execute(sql`DELETE FROM note_reads WHERE note_id IN (SELECT id FROM notes WHERE vault_id = ${vaultId})`)
  // Runtime import avoids the store → search → repository-store initialization cycle.
  const { clearSearchCache } = await import('../cache/search.js')
  clearSearchCache()
}
