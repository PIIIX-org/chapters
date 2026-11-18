import { and, eq, sql } from 'drizzle-orm'
import { join } from 'node:path'
import { db } from '../db/client.js'
import { notes, noteRevisions } from '../db/schema.js'
import { atomicWrite } from '../notes/atomic-write.js'
import { revisionBody } from '../notes/store-tx.js'
import {
  compareAndSetAsset, createNote, getLiveNote, NoteCompareError, readLiveNote,
  recordProposal, softDeleteNote, vaultDir, type Actor, type RecordKey,
} from '../notes/store.js'
import { NoteEditConflictError, writeThroughCollab, type EditBase } from '../sync/crdt-write.js'
import type { McpAuth } from '../vaults/mcp-connection-routes.js'
import { GitPushError, gitTimeLimit, PACK_LIMITS } from './pack.js'
import { admitAssetProposals, admitImport, GIT_QUOTAS, operationResults, proposalFrontmatterBytes, recordOperation, type OperationResult } from './metadata.js'
import { ASSET_PREFIX, assetNameFromGitPath, type Manifest, type NoteBase, type TreeFile } from './tree.js'

async function baseRevision(vaultId: string, base: NoteBase): Promise<EditBase | null> {
  const [revision] = await db.select({ id: noteRevisions.id, body: revisionBody, frontmatter: noteRevisions.frontmatter })
    .from(noteRevisions).innerJoin(notes, eq(notes.id, noteRevisions.noteId))
    .where(and(eq(notes.vaultId, vaultId), eq(notes.id, base.id), sql`note_revisions.seq = ${base.rev}`, sql`note_revisions.action NOT IN ('proposal', 'quarantine')`))
  return revision ? { ...revision, frontmatter: revision.frontmatter as Record<string, unknown> } : null
}

export function assetProposalFile(vaultId: string, commitId: string, name: string): string {
  return join(vaultDir(vaultId), '.git-proposals', commitId, name)
}

export interface ImportResult { complete: boolean; error?: string; results: Array<{ path: string; result: OperationResult }> }

/**
 * Not a cross-note transaction. Every applied note has a receipt in its own store transaction.
 * On conflict/failure the Git ref is NOT acknowledged; receipts expose partial effects and make retry idempotent.
 * No compensating rollback is attempted: that would overwrite typing after a successful operation.
 */
export async function applyTree(vaultId: string, auth: McpAuth, commitId: string, manifest: Manifest, tree: Map<string, TreeFile>, checkWrite: () => Promise<McpAuth>): Promise<ImportResult> {
  const connectionId = auth.connection.id
  const actor: Actor = { type: 'mcp', id: connectionId }
  const existing = await operationResults(vaultId, connectionId, commitId)
  if (existing.some(entry => entry.result.purged)) {
    return { complete: false, error: 'this import attempt was purged; it cannot be applied again', results: existing }
  }
  const done = new Map(existing.map((entry) => [entry.path, entry.result]))
  const paths = [...new Set([...Object.keys(manifest.notes), ...Object.keys(manifest.assets), ...tree.keys()])].sort()
  const changed = paths.filter((path) => (manifest.notes[path]?.blob ?? manifest.assets[path]) !== tree.get(path)?.oid)
  if (new Set([...changed, ...existing.map(entry => entry.path).filter(Boolean)]).size > 128) throw new GitPushError('at most 128 distinct file operations per import attempt are supported')
  const deadline = performance.now() + gitTimeLimit(30_000)
  const bases = new Map<string, EditBase>()
  const checkTool = (latest: McpAuth, path: string) => {
    const base = manifest.notes[path]
    const tool = path.startsWith(ASSET_PREFIX) ? 'edit_note' : base ? tree.has(path) ? 'edit_note' : 'delete_note' : 'create_note'
    if (latest.connection.allowedTools && !latest.connection.allowedTools.includes(tool)) throw new GitPushError(`token does not allow ${tool}`)
    if (tool === 'delete_note' && latest.connection.profile !== 'admin') throw new GitPushError('delete_note requires the admin profile')
  }
  // Resolve every identity/revision and tool permission BEFORE the first mutation.
  for (const path of changed) {
    if (done.has(path)) continue
    const base = manifest.notes[path]
    checkTool(auth, path)
    if (base) {
      const revision = await baseRevision(vaultId, base)
      if (!revision) throw new GitPushError('a pushed base revision was purged; fetch and rebase before pushing')
      bases.set(path, revision)
    }
  }
  const pending = changed.filter(path => !done.has(path))
  if (pending.length === 0) return { complete: existing.every(entry => entry.result.status === 'applied'), results: existing }
  const notePaths = pending.filter(path => !path.startsWith(ASSET_PREFIX))
  const proposalLimit = GIT_QUOTAS.noteProposalBytes
  const proposalBytes = notePaths.reduce((total, path) => {
    if (total > proposalLimit) return total
    const proposed = tree.get(path)?.note
    const bodyBytes = Buffer.byteLength(proposed?.body ?? '')
    if (bodyBytes > proposalLimit - total) return proposalLimit + 1
    return total + bodyBytes + proposalFrontmatterBytes(proposed?.frontmatter ?? bases.get(path)?.frontmatter ?? {}, proposalLimit - total - bodyBytes)
  }, 0)
  await admitImport(vaultId, pending.length, proposalBytes, notePaths.length)
  const assetCandidates = new Map(pending.filter(path => path.startsWith(ASSET_PREFIX) && tree.has(path))
    .map(path => [assetNameFromGitPath(path), tree.get(path)!.data.length]))
  if (assetCandidates.size > 0) await admitAssetProposals(vaultId, commitId, assetCandidates)
  for (const path of changed) {
    if (done.has(path)) continue
    if (performance.now() > deadline) return { complete: false, error: 'import time limit reached; retry resumes unapplied operations', results: await operationResults(vaultId, connectionId, commitId) }
    checkTool(await checkWrite(), path)
    const proposed = tree.get(path)
    const base = manifest.notes[path]
    const revision = bases.get(path)
    const action: OperationResult['action'] = path.startsWith(ASSET_PREFIX) ? 'asset' : !base ? 'create' : proposed ? 'edit' : 'delete'
    const record: RecordKey = async (tx, row) => {
      await recordOperation(tx, vaultId, connectionId, commitId, path, { action, status: 'applied', noteId: row.id, rev: row.seq })
    }
    try {
      if (action === 'asset') {
        const name = assetNameFromGitPath(path)
        const applied = await compareAndSetAsset(vaultId, name, manifest.assets[path] ?? null, proposed?.data ?? null, PACK_LIMITS.object)
        if (!applied && proposed) await atomicWrite(assetProposalFile(vaultId, commitId, name), proposed.data, { mode: 0o600, durable: true, shortTempName: true })
        await recordOperation(db, vaultId, connectionId, commitId, path, { action, status: applied ? 'applied' : 'conflicted', ...(!applied ? { error: proposed ? 'asset changed since base; proposed file is available from the push report API' : 'asset changed since base; deletion was not applied' } : {}) })
      } else if (!base) {
        // The unique path index decides creates. A concurrently created note becomes a reviewable proposal, never an upsert.
        try {
          await createNote(vaultId, { path: path.slice(0, -3), ...proposed!.note! }, actor, { asImported: true, recordKey: record })
        } catch (err) {
          const collision = await readLiveNote(vaultId, path.slice(0, -3))
          if (!collision) throw err
          const collisionBase = await baseRevision(vaultId, { id: collision.row.id, rev: collision.row.seq, blob: '' })
          if (!collisionBase) throw err
          const proposalId = await recordProposal(collision.row.id, proposed!.note!, actor, collisionBase.id, { kind: 'git_push', commit: commitId, operation: action })
          await recordOperation(db, vaultId, connectionId, commitId, path, { action, status: 'conflicted', noteId: collision.row.id, proposalId, error: 'a live note already occupies the new path' })
        }
      } else {
        const live = await getLiveNote(vaultId, path.slice(0, -3))
        if (!live || live.id !== base.id) {
          // Identity is pinned to the served note, not the current occupant of its old path.
          const proposalId = await recordProposal(base.id, proposed?.note ?? { frontmatter: revision!.frontmatter, body: '' }, actor, revision!.id, { kind: 'git_push', commit: commitId, operation: action })
          await recordOperation(db, vaultId, connectionId, commitId, path, { action, status: 'conflicted', noteId: base.id, proposalId, error: 'the served note was renamed or deleted; no replacement note was touched' })
        } else if (proposed) {
          const written = await writeThroughCollab(vaultId, live.path, { ...proposed.note!, frontmatterMode: 'replace', base: revision }, actor,
            { expectedNoteId: base.id, recordKey: record, actorDetail: { kind: 'git_push', commit: commitId, operation: action } })
          if (!written) throw new GitPushError('the note moved during import; retry to create a proposal')
        } else {
          try {
            const written = await softDeleteNote(vaultId, live.path, actor, { expected: { id: base.id, frontmatter: revision!.frontmatter, body: revision!.body }, recordKey: record })
            if (!written) throw new GitPushError('the note moved during import; retry to create a proposal')
          } catch (err) {
            if (!(err instanceof NoteCompareError)) throw err
            const proposalId = await recordProposal(base.id, { frontmatter: revision!.frontmatter, body: '' }, actor, revision!.id, { kind: 'git_push', commit: commitId, operation: action })
            await recordOperation(db, vaultId, connectionId, commitId, path, { action, status: 'conflicted', noteId: base.id, proposalId, error: 'deletion conflicts with a changed note; review the delete intent in this push report' })
          }
        }
      }
    } catch (err) {
      if (err instanceof NoteEditConflictError && err.proposalId) {
        await recordOperation(db, vaultId, connectionId, commitId, path, { action, status: 'conflicted', noteId: base!.id, proposalId: err.proposalId })
      } else {
        return { complete: false, error: err instanceof Error ? err.message : 'store refused the push', results: await operationResults(vaultId, connectionId, commitId) }
      }
    }
  }
  const results = await operationResults(vaultId, connectionId, commitId)
  return { complete: results.every((entry) => entry.result.status === 'applied'), results }
}
