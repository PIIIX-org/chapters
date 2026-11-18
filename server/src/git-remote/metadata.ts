import { and, asc, eq, sql } from 'drizzle-orm'
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'
import { GitPushError, gitTimeLimit } from './pack.js'
import { db } from '../db/client.js'
import { vaultGitPushOperations, vaultGitSnapshots } from '../db/schema.js'
import type { Tx } from '../notes/store-tx.js'
import type { Manifest } from './tree.js'

// Admission limits, not eviction policies. Existing bases and pending evidence never expire.
export const GIT_QUOTAS = {
  snapshots: 4096, operations: 65_536, metadataBytes: 256 * 1024 * 1024,
  manifestBytes: 4 * 1024 * 1024, operationBytes: 8192,
  noteProposals: 4096, noteProposalBytes: 256 * 1024 * 1024,
  assetProposals: 4096, assetProposalBytes: 128 * 1024 * 1024,
}

async function metadataUsage(vaultId: string) {
  const [usage] = (await db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${`${Math.ceil(gitTimeLimit())}ms`}, true)`)
    return tx.execute(sql`
    WITH snapshots AS (
      SELECT count(*)::int AS snapshots, coalesce(sum(pg_column_size(manifest)), 0)::float8 AS bytes
      FROM vault_git_snapshots WHERE vault_id = ${vaultId}
    ), operations AS (
      SELECT count(*)::int AS operations, coalesce(sum(pg_column_size(result) + octet_length(path) + 128), 0)::float8 AS bytes
      FROM vault_git_push_operations WHERE vault_id = ${vaultId}
    ), proposals AS (
      SELECT count(*)::int AS proposals, coalesce(sum(octet_length(r.body) + octet_length(r.frontmatter::text)), 0)::float8 AS bytes
      FROM note_revisions r JOIN notes n ON n.id = r.note_id
      WHERE n.vault_id = ${vaultId} AND r.action = 'proposal' AND r.actor_detail->>'kind' = 'git_push'
    )
    SELECT snapshots.snapshots, operations.operations, snapshots.bytes + operations.bytes AS bytes,
      proposals.proposals, proposals.bytes AS proposal_bytes FROM snapshots, operations, proposals
  `)
  }, { accessMode: 'read only' })) as unknown as Array<{ snapshots: number; operations: number; bytes: number; proposals: number; proposal_bytes: number }>
  if (!usage) throw new GitPushError('Git metadata accounting unavailable')
  return usage
}

/** UNDER withVaultGit: no other Git allocator can consume this allowance before the import finishes. */
export async function admitImport(vaultId: string, operations: number, proposalBytes: number, noteOperations: number): Promise<void> {
  const usage = await metadataUsage(vaultId)
  if (usage.snapshots + 1 > GIT_QUOTAS.snapshots || usage.operations + operations > GIT_QUOTAS.operations ||
      usage.bytes + GIT_QUOTAS.manifestBytes + operations * GIT_QUOTAS.operationBytes > GIT_QUOTAS.metadataBytes ||
      usage.proposals + noteOperations > GIT_QUOTAS.noteProposals || usage.proposal_bytes + proposalBytes > GIT_QUOTAS.noteProposalBytes) {
    throw new GitPushError('Git metadata/proposal capacity is full; no import changes applied; retained bases and evidence were not evicted')
  }
}

/** Check before moving an export ref; a push has already allowed for one maximum-sized mapping. */
export async function admitSnapshot(vaultId: string, manifest: Manifest): Promise<void> {
  const bytes = Buffer.byteLength(JSON.stringify(manifest))
  const usage = await metadataUsage(vaultId)
  if (bytes > GIT_QUOTAS.manifestBytes || usage.snapshots + 1 > GIT_QUOTAS.snapshots ||
      usage.bytes + bytes + 128 > GIT_QUOTAS.metadataBytes) throw new GitPushError('Git snapshot metadata capacity is full; retained bases were not evicted')
}

/** Include crash-orphaned files: disk evidence is never silently dropped just because its receipt was interrupted. */
export async function admitAssetProposals(vaultId: string, commitId: string, candidates: Map<string, number>): Promise<void> {
  const root = join(config.dataDir, 'vaults', vaultId, '.git-proposals')
  let count = 0
  let bytes = 0
  const deadline = performance.now() + gitTimeLimit()
  let directories = 0
  const existing = new Map<string, number>()
  const directory = await opendir(root).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (directory) for await (const entry of directory) {
    if (!entry.isDirectory() || !/^[0-9a-f]{40}$/.test(entry.name)) throw new GitPushError('unsafe Git proposal storage')
    if (++directories > GIT_QUOTAS.assetProposals || performance.now() > deadline) throw new GitPushError('Git proposal scan limit exceeded')
    for await (const file of await opendir(join(root, entry.name))) {
      if (!file.isFile()) throw new GitPushError('unsafe Git proposal file')
      if (performance.now() > deadline) throw new GitPushError('Git proposal scan time limit exceeded')
      const info = await lstat(join(root, entry.name, file.name))
      if (!info.isFile()) throw new GitPushError('unsafe Git proposal file')
      count++
      bytes += info.size
      if (entry.name === commitId) existing.set(file.name, info.size)
      if (count > GIT_QUOTAS.assetProposals || bytes > GIT_QUOTAS.assetProposalBytes) throw new GitPushError('Git asset proposal capacity is full; evidence was not evicted')
    }
  }
  for (const [name, size] of candidates) {
    if (!existing.has(name)) count++
    bytes += Math.max(0, size - (existing.get(name) ?? 0))
  }
  if (count > GIT_QUOTAS.assetProposals || bytes > GIT_QUOTAS.assetProposalBytes) throw new GitPushError('Git asset proposal capacity is full; no import changes applied; evidence was not evicted')
}

export interface OperationResult {
  action: 'create' | 'edit' | 'delete' | 'asset' | 'purged'
  status: 'applied' | 'conflicted'
  noteId?: string
  rev?: number
  proposalId?: string
  error?: string
  purged?: true
}

export type GitPurgeScope = 'vault' | { noteId: string; revision?: { id: string; rev: number } }

export async function saveManifest(vaultId: string, commitId: string, manifest: Manifest): Promise<void> {
  if (await loadManifest(vaultId, commitId)) return
  await admitSnapshot(vaultId, manifest)
  await db.insert(vaultGitSnapshots).values({ vaultId, commitId, manifest }).onConflictDoNothing()
}

export async function loadManifest(vaultId: string, commitId: string): Promise<Manifest | null> {
  const [row] = await db.select({ manifest: vaultGitSnapshots.manifest }).from(vaultGitSnapshots)
    .where(and(eq(vaultGitSnapshots.vaultId, vaultId), eq(vaultGitSnapshots.commitId, commitId)))
  return row ? row.manifest as Manifest : null
}

/** Private server journal, never client commit metadata. Indexed by vault and parent. */
export async function loadPreparedSnapshot(vaultId: string, parent: string, manifest: Manifest): Promise<{ commitId: string; when: number } | null> {
  const rows = await db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${`${Math.ceil(gitTimeLimit())}ms`}, true)`)
    return tx.execute(sql`
      SELECT commit_id, (manifest->'prepared'->>'when')::float8 AS export_time
      FROM vault_git_snapshots
      WHERE vault_id = ${vaultId} AND manifest->'prepared'->>'parent' = ${parent}
        AND manifest->'notes' = ${JSON.stringify(manifest.notes)}::jsonb
        AND manifest->'assets' = ${JSON.stringify(manifest.assets)}::jsonb
      ORDER BY created_at, commit_id LIMIT 1`)
  }, { accessMode: 'read only' }) as unknown as Array<{ commit_id: string; export_time: number }>
  const row = rows[0]
  if (!row) return null
  if (!Number.isSafeInteger(row.export_time) || row.export_time < 0) throw new GitPushError('invalid private export journal')
  return { commitId: row.commit_id, when: row.export_time }
}

export async function operationResults(vaultId: string, connectionId: string, commitId: string): Promise<Array<{ path: string; result: OperationResult }>> {
  const rows = await db.select({ path: vaultGitPushOperations.path, result: vaultGitPushOperations.result }).from(vaultGitPushOperations)
    .where(and(eq(vaultGitPushOperations.vaultId, vaultId), eq(vaultGitPushOperations.connectionId, connectionId), eq(vaultGitPushOperations.commitId, commitId)))
    .orderBy(asc(vaultGitPushOperations.path))
    .limit(129)
  return rows as Array<{ path: string; result: OperationResult }>
}

export async function recordOperation(client: Tx | typeof db, vaultId: string, connectionId: string, commitId: string, path: string, result: OperationResult): Promise<void> {
  if (Buffer.byteLength(path) + Buffer.byteLength(JSON.stringify(result)) + 128 > GIT_QUOTAS.operationBytes) throw new GitPushError('Git operation metadata exceeds its reservation')
  await client.insert(vaultGitPushOperations).values({ vaultId, connectionId, commitId, path, result }).onConflictDoNothing()
}

/** Redact only affected receipt payloads; a mixed attempt cannot replay, but its other proposals remain reviewable. */
export async function purgePushReports(tx: Tx, vaultId: string, scope: GitPurgeScope): Promise<void> {
  const affected = scope === 'vault' ? sql`TRUE`
    : scope.revision
      ? sql`((result->>'noteId' = ${scope.noteId} AND result->>'rev' = ${String(scope.revision.rev)})
          OR result->>'proposalId' = ${scope.revision.id})`
      : sql`result->>'noteId' = ${scope.noteId}`
  const tombstone: OperationResult = {
    action: 'purged', status: 'conflicted', purged: true,
    error: 'purged; retry refused',
  }
  // A proposal can commit before its receipt does. Preserve the retry fence
  // from its trusted provenance even when that earlier process crashed.
  const proposalAffected = scope === 'vault' ? sql`TRUE`
    : scope.revision
      ? sql`r.note_id = ${scope.noteId} AND r.id = ${scope.revision.id}`
      : sql`r.note_id = ${scope.noteId}`
  await tx.execute(sql`
    INSERT INTO vault_git_push_operations (vault_id, connection_id, commit_id, path, result)
    SELECT DISTINCT n.vault_id, c.id, r.actor_detail->>'commit', '', ${JSON.stringify(tombstone)}::jsonb
    FROM note_revisions r JOIN notes n ON n.id = r.note_id
    JOIN mcp_connections c ON c.id = r.actor_id
    WHERE n.vault_id = ${vaultId} AND r.actor_type = 'mcp' AND r.action = 'proposal'
      AND r.actor_detail->>'kind' = 'git_push'
      AND r.actor_detail->>'commit' ~ '^[0-9a-f]{40}$' AND ${proposalAffected}
    ON CONFLICT (vault_id, connection_id, commit_id, path) DO UPDATE SET result = EXCLUDED.result`)
  await tx.execute(sql`
    INSERT INTO vault_git_push_operations (vault_id, connection_id, commit_id, path, result)
    SELECT DISTINCT vault_id, connection_id, commit_id, '', ${JSON.stringify(tombstone)}::jsonb
    FROM vault_git_push_operations WHERE vault_id = ${vaultId} AND path <> '' AND ${affected}
    ON CONFLICT (vault_id, connection_id, commit_id, path) DO UPDATE SET result = EXCLUDED.result`)
  await tx.execute(sql`DELETE FROM vault_git_push_operations WHERE vault_id = ${vaultId} AND path <> '' AND ${affected}`)
}
