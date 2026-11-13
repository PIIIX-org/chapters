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
import { GitPushError } from './pack.js'
import { operationResults, recordOperation, type OperationResult } from './metadata.js'
import type { Manifest, NoteBase, TreeFile } from './tree.js'

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
export async function applyTree(vaultId: string, auth: McpAuth, commitId: string, manifest: Manifest, tree: Map<string, TreeFile>): Promise<ImportResult> {
  const connectionId = auth.connection.id
  const actor: Actor = { type: 'mcp', id: connectionId }
  const existing = await operationResults(vaultId, connectionId, commitId)
  const done = new Map(existing.map((entry) => [entry.path, entry.result]))
  const paths = [...new Set([...Object.keys(manifest.notes), ...Object.keys(manifest.assets), ...tree.keys()])].sort()
  const changed = paths.filter((path) => (manifest.notes[path]?.blob ?? manifest.assets[path]) !== tree.get(path)?.oid)
  if (changed.length > 128) throw new GitPushError('at most 128 changed files per push are supported')
  const deadline = performance.now() + 30_000
  const bases = new Map<string, EditBase>()
  // Resolve every identity/revision and tool permission BEFORE the first mutation.
  for (const path of changed) {
    if (done.has(path)) continue
    const base = manifest.notes[path]
    const tool = path.startsWith('assets/') ? 'edit_note' : base ? tree.has(path) ? 'edit_note' : 'delete_note' : 'create_note'
    if (auth.connection.allowedTools && !auth.connection.allowedTools.includes(tool)) throw new GitPushError(`token does not allow ${tool}`)
    if (tool === 'delete_note' && auth.connection.profile !== 'admin') throw new GitPushError('delete_note requires the admin profile')
    if (base) {
      const revision = await baseRevision(vaultId, base)
      if (!revision) throw new GitPushError('a pushed base revision was purged or compacted; fetch and rebase before pushing')
      bases.set(path, revision)
    }
  }
  for (const path of changed) {
    if (done.has(path)) continue
    if (performance.now() > deadline) return { complete: false, error: 'import time limit reached; retry resumes unapplied operations', results: await operationResults(vaultId, connectionId, commitId) }
    const proposed = tree.get(path)
    const base = manifest.notes[path]
    const revision = bases.get(path)
    const action: OperationResult['action'] = path.startsWith('assets/') ? 'asset' : !base ? 'create' : proposed ? 'edit' : 'delete'
    const record: RecordKey = async (tx, row) => {
      await recordOperation(tx, vaultId, connectionId, commitId, path, { action, status: 'applied', noteId: row.id, rev: row.seq })
    }
    try {
      if (action === 'asset') {
        const name = path.slice(7)
        const applied = await compareAndSetAsset(vaultId, name, manifest.assets[path] ?? null, proposed?.data ?? null)
        if (!applied && proposed) await atomicWrite(assetProposalFile(vaultId, commitId, name), proposed.data, { mode: 0o600 })
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
          const proposalId = await recordProposal(collision.row.id, proposed!.note!, actor, collisionBase.id)
          await recordOperation(db, vaultId, connectionId, commitId, path, { action, status: 'conflicted', noteId: collision.row.id, proposalId, error: 'a live note already occupies the new path' })
        }
      } else {
        const live = await getLiveNote(vaultId, path.slice(0, -3))
        if (!live || live.id !== base.id) {
          // Identity is pinned to the served note, not the current occupant of its old path.
          const proposalId = await recordProposal(base.id, proposed?.note ?? { frontmatter: revision!.frontmatter, body: '' }, actor, revision!.id)
          await recordOperation(db, vaultId, connectionId, commitId, path, { action, status: 'conflicted', noteId: base.id, proposalId, error: 'the served note was renamed or deleted; no replacement note was touched' })
        } else if (proposed) {
          const written = await writeThroughCollab(vaultId, live.path, { ...proposed.note!, frontmatterMode: 'replace', base: revision }, actor,
            { expectedNoteId: base.id, recordKey: record, actorDetail: { kind: 'git_push', commit: commitId } })
          if (!written) throw new GitPushError('the note moved during import; retry to create a proposal')
        } else {
          try {
            const written = await softDeleteNote(vaultId, live.path, actor, { expected: { id: base.id, frontmatter: revision!.frontmatter, body: revision!.body }, recordKey: record })
            if (!written) throw new GitPushError('the note moved during import; retry to create a proposal')
          } catch (err) {
            if (!(err instanceof NoteCompareError)) throw err
            const proposalId = await recordProposal(base.id, { frontmatter: revision!.frontmatter, body: '' }, actor, revision!.id)
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
