import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { vaultGitPushOperations, vaultGitSnapshots } from '../db/schema.js'
import type { Tx } from '../notes/store-tx.js'
import type { Manifest } from './tree.js'

export interface OperationResult {
  action: 'create' | 'edit' | 'delete' | 'asset'
  status: 'applied' | 'conflicted'
  noteId?: string
  rev?: number
  proposalId?: string
  error?: string
}

export async function saveManifest(vaultId: string, commitId: string, manifest: Manifest): Promise<void> {
  await db.insert(vaultGitSnapshots).values({ vaultId, commitId, manifest }).onConflictDoNothing()
}

export async function loadManifest(vaultId: string, commitId: string): Promise<Manifest | null> {
  const [row] = await db.select({ manifest: vaultGitSnapshots.manifest }).from(vaultGitSnapshots)
    .where(and(eq(vaultGitSnapshots.vaultId, vaultId), eq(vaultGitSnapshots.commitId, commitId)))
  return row ? row.manifest as Manifest : null
}

export async function operationResults(vaultId: string, connectionId: string, commitId: string): Promise<Array<{ path: string; result: OperationResult }>> {
  const rows = await db.select({ path: vaultGitPushOperations.path, result: vaultGitPushOperations.result }).from(vaultGitPushOperations)
    .where(and(eq(vaultGitPushOperations.vaultId, vaultId), eq(vaultGitPushOperations.connectionId, connectionId), eq(vaultGitPushOperations.commitId, commitId)))
    .orderBy(asc(vaultGitPushOperations.path))
  return rows as Array<{ path: string; result: OperationResult }>
}

export async function recordOperation(client: Tx | typeof db, vaultId: string, connectionId: string, commitId: string, path: string, result: OperationResult): Promise<void> {
  await client.insert(vaultGitPushOperations).values({ vaultId, connectionId, commitId, path, result }).onConflictDoNothing()
}
