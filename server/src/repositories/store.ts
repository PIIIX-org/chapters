import { createHash } from 'node:crypto'
import { and, asc, eq, notInArray, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/client.js'
import { blocks, jobs, repositories, repositoryChanges, repositoryFiles, repositoryVersions } from '../db/schema.js'
import { kickSemanticEdges, removeSemanticNodes } from '../search/semantic-edges.js'
import { detectLanguage } from './language.js'
import { enqueueExtractions, extractionJobKeySql, hasCurrentBlocksSql, scheduleImportReresolution } from './extraction-queue.js'
import { lockRepositoryEdges, nearFiles, reresolveAfterChange, storedDefinitions } from './code-edges.js'
import { isResolutionManifest } from './import-resolution.js'
import { checkCodeStaleness } from '../notes/staleness.js'

export type RepositoryFileRow = typeof repositoryFiles.$inferSelect

export interface FileUpdate {
  path: string
  content: string
  sourceModifiedAt?: Date
}

export interface SyncResult {
  created: number
  updated: number
  deleted: number
  unchanged: number
}

/**
 * The version an index was built from (#471, ADR-004 §2.9), as answers name
 * it once: the commit when one is known, else the tree hash, else nothing
 * (never synced).
 */
/** Index versions a repository keeps for `changed_since` (#471); older ones and their changes are dropped. */
export const VERSIONS_KEPT = 200

export type IndexedVersion = { commit: string } | { tree: string } | Record<string, never>

export function indexedVersion(r: { lastSyncedCommit: string | null; treeHash: string | null }): IndexedVersion {
  if (r.lastSyncedCommit) return { commit: r.lastSyncedCommit }
  return r.treeHash ? { tree: r.treeHash } : {}
}

/** `indexedVersion` of a repository by id ({} when there is no such row). */
export async function repositoryIndexedVersion(repositoryId: string): Promise<IndexedVersion> {
  const [row] = await db
    .select({ lastSyncedCommit: repositories.lastSyncedCommit, treeHash: repositories.treeHash })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
  return row ? indexedVersion(row) : {}
}

/**
 * The tree hash of a set of indexed files (#471): the first 16 hex characters
 * of sha256 over one `path NUL content_hash LF` line per file, in path byte
 * (UTF-8) order, which is Postgres `COLLATE "C"` order (migration 0040
 * backfills with the same lines).
 */
export function computeTreeHash(hashByPath: ReadonlyMap<string, string>): string {
  const paths = [...hashByPath.keys()]
  // Without surrogate pairs (astral characters), UTF-16 code-unit order, the
  // default sort, is byte order; 20k paths hash in ~7 ms this way, ~24 ms
  // through Buffers.
  if (paths.some((p) => /[\uD800-\uDFFF]/.test(p))) paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  else paths.sort()
  let lines = ''
  for (const path of paths) lines += `${path}\0${hashByPath.get(path)}\n`
  return createHash('sha256').update(lines).digest('hex').slice(0, 16)
}

/**
 * The one write path for repository file content (spec 8): every
 * ingestion method funnels through here. `contentHash` is always
 * computed server-side from the stored `content` (NUL bytes removed first:
 * stored text = hashed text, #418) — never trusted from a caller,
 * since the server is the single source of truth regardless of how the
 * content arrived.
 *
 * It also records the indexed version (#471): the tree hash, from the rows
 * it already loaded plus this batch's hashes (no rescan), and `commit` when
 * the caller passes one (null clears it; undefined leaves it).
 */
export async function syncRepositoryFiles(
  repositoryId: string,
  changedOrNewFiles: FileUpdate[],
  currentPaths: string[],
  indexed: { commit?: string | null } = {},
): Promise<SyncResult> {
  const existing = await db
    .select({ id: repositoryFiles.id, path: repositoryFiles.path, contentHash: repositoryFiles.contentHash })
    .from(repositoryFiles)
    .where(eq(repositoryFiles.repositoryId, repositoryId))
  const existingByPath = new Map(existing.map((r) => [r.path, r]))
  // The files as this sync leaves them, for the tree hash (#471).
  const hashByPath = new Map(existing.map((r) => [r.path, r.contentHash]))

  const result: SyncResult = { created: 0, updated: 0, deleted: 0, unchanged: 0 }
  // Extraction is scheduled only after the whole batch is persisted (below)
  // — starting it per-file would race cross-file import resolution against
  // sibling files in the same batch still being inserted.
  const toExtract: string[] = []
  // A package.json, workspace or tsconfig change can change what any import of the repository resolves to (#466).
  let manifestChanged = false
  // A path created or deleted can change what the imports that tried it resolve to (#1008).
  const createdOrDeleted: string[] = []
  // The version this sync's changes belong to (#471): the one it records at its end. Each change is written in the
  // transaction of its file's write, so a sync that stops midway leaves its changes under that version number and the
  // next sync records them (a repository with no version yet records none: its first version is the baseline).
  const [started] = await db.select({ seq: repositories.versionSeq }).from(repositories).where(eq(repositories.id, repositoryId))
  const pendingSeq = (started?.seq ?? 0) + 1
  const recordChange = async (tx: Pick<typeof db, 'select' | 'insert' | 'delete'>, path: string, kind: 'added' | 'modified' | 'deleted') => {
    if (pendingSeq === 1) return
    const where = and(eq(repositoryChanges.repositoryId, repositoryId), eq(repositoryChanges.seq, pendingSeq), eq(repositoryChanges.path, path))
    const [earlier] = await tx.select({ kind: repositoryChanges.kind }).from(repositoryChanges).where(where)
    // Within one version: added then changed stays added, added then deleted is nothing, deleted then added is changed.
    const net = earlier?.kind === 'added' ? (kind === 'deleted' ? null : 'added') : earlier?.kind === 'deleted' && kind === 'added' ? 'modified' : kind
    if (net === null) await tx.delete(repositoryChanges).where(where)
    else await tx.insert(repositoryChanges).values({ repositoryId, seq: pendingSeq, path, kind: net }).onConflictDoUpdate({ target: [repositoryChanges.repositoryId, repositoryChanges.seq, repositoryChanges.path], set: { kind: net } })
  }

  for (const file of changedOrNewFiles) {
    // Pushed content is text the client chose to send, so a stray NUL is
    // stripped. Git and local-path scans skip a file with a NUL as binary
    // before it gets here (readRepositoryFiles in fs-scan.ts, #923). The hash
    // is of the stored, stripped text (#418).
    const cleanContent = file.content.replace(/\0/g, '')
    const contentHash = createHash('sha256').update(cleanContent).digest('hex')
    const current = existingByPath.get(file.path)
    hashByPath.set(file.path, contentHash)
    if (current && current.contentHash === contentHash) {
      result.unchanged += 1
      continue
    }
    const values = {
      repositoryId,
      path: file.path,
      language: detectLanguage(file.path),
      content: cleanContent,
      contentHash,
      size: Buffer.byteLength(cleanContent, 'utf8'),
      sourceModifiedAt: file.sourceModifiedAt,
      updatedAt: new Date(),
    }
    if (current) {
      await db.transaction(async (tx) => {
        await tx.update(repositoryFiles).set(values).where(eq(repositoryFiles.id, current.id))
        await recordChange(tx, file.path, 'modified')
      })
      toExtract.push(current.id)
      result.updated += 1
    } else {
      const inserted = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(repositoryFiles)
          .values(values)
          .onConflictDoUpdate({
            target: [repositoryFiles.repositoryId, repositoryFiles.path],
            set: values,
          })
          .returning({ id: repositoryFiles.id })
        await recordChange(tx, file.path, 'added')
        return row
      })
      if (inserted) toExtract.push(inserted.id)
      createdOrDeleted.push(file.path)
      result.created += 1
    }
    if (isResolutionManifest(file.path)) manifestChanged = true
  }

  const currentPathSet = new Set(currentPaths)
  const toDelete = existing.filter((r) => !currentPathSet.has(r.path))
  if (toDelete.length > 0) {
    // Same as notes: semanticEdges has no FK and does not cascade (#92). The files' rows go in the delete's
    // transaction and the nodes that held one are queued once each (#1015), the batch file below too. Under the
    // repository's code edge lock (#469): the code edges that named a deleted file's definitions, or resolved
    // through it, resolve again without them in the same transaction.
    const deletedIds = toDelete.map((r) => r.id)
    await db.transaction(async (tx) => {
      await lockRepositoryEdges(tx, repositoryId)
      const definitions = await storedDefinitions(tx, deletedIds)
      const near = definitions.size > 0 ? await nearFiles(tx, repositoryId, deletedIds) : []
      const deleted = await tx
        .delete(repositoryFiles)
        .where(
          and(
            eq(repositoryFiles.repositoryId, repositoryId),
            notInArray(repositoryFiles.path, currentPaths.length > 0 ? currentPaths : ['__empty_repository_path__']),
          ),
        )
        .returning({ id: repositoryFiles.id })
      const deletedNow = deleted.map((r) => r.id)
      for (const r of toDelete) await recordChange(tx, r.path, 'deleted')
      await removeSemanticNodes(tx, 'code', repositoryId, deletedNow)
      const gone = new Set(deletedNow)
      await reresolveAfterChange(tx, repositoryId, deletedNow, [...definitions.values()], near.filter((id) => !gone.has(id)))
    })
    kickSemanticEdges()
    result.deleted = toDelete.length
    if (toDelete.some((r) => isResolutionManifest(r.path))) manifestChanged = true
    for (const r of toDelete) createdOrDeleted.push(r.path)
    // The delete also takes a batch file outside currentPaths.
    for (const path of hashByPath.keys()) if (!currentPathSet.has(path)) hashByPath.delete(path)
  }

  // The tree hash, the commit and, when files or the commit changed (changes recorded above, here or by a sync that
  // stopped), the version they make (#471). The versions older than the last VERSIONS_KEPT are dropped with their changes.
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ commit: repositories.lastSyncedCommit, seq: repositories.versionSeq })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .for('update')
    if (!before) return
    const commit = indexed.commit !== undefined ? indexed.commit : before.commit
    const treeHash = computeTreeHash(hashByPath)
    const seq = before.seq + 1
    // Another sync recorded a version since this one started: its changes join the next one.
    if (seq !== pendingSeq && pendingSeq > 1) {
      await tx.update(repositoryChanges).set({ seq }).where(and(eq(repositoryChanges.repositoryId, repositoryId), eq(repositoryChanges.seq, pendingSeq)))
    }
    const [pending] = await tx.select({ n: sql<number>`count(*)::int` }).from(repositoryChanges).where(and(eq(repositoryChanges.repositoryId, repositoryId), eq(repositoryChanges.seq, seq)))
    const record = before.seq === 0 || (pending?.n ?? 0) > 0 || commit !== before.commit
    await tx
      .update(repositories)
      .set({ treeHash, lastSyncedCommit: commit, ...(record ? { versionSeq: seq } : {}) })
      .where(eq(repositories.id, repositoryId))
    if (!record) return
    await tx.insert(repositoryVersions).values({ repositoryId, seq, commit, treeHash })
    await tx.delete(repositoryVersions).where(and(eq(repositoryVersions.repositoryId, repositoryId), sql`${repositoryVersions.seq} <= ${seq - VERSIONS_KEPT}`))
    await tx.delete(repositoryChanges).where(and(eq(repositoryChanges.repositoryId, repositoryId), sql`${repositoryChanges.seq} <= ${seq - VERSIONS_KEPT}`))
  })

  if (manifestChanged || createdOrDeleted.length > 0) {
    scheduleImportReresolution(repositoryId, { manifests: manifestChanged, paths: createdOrDeleted })
  }

  await enqueueExtractions(toExtract)
  checkCodeStaleness(repositoryId).catch(console.error)

  return result
}

/**
 * Deletes a repository (REST and MCP): its files cascade, their blocks with them (a trigger); the files'
 * semantic edges, which have no foreign key (#92), go in the same transaction, and the notes that held one are
 * queued (#1015).
 */
export async function deleteRepositoryRecord(repositoryId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await removeSemanticNodes(tx, 'code', repositoryId, sql`SELECT id FROM repository_files WHERE repository_id = ${repositoryId}`)
    await tx.delete(repositories).where(eq(repositories.id, repositoryId))
  })
  kickSemanticEdges()
}

export async function getRepositoryFile(
  repositoryId: string,
  path: string,
): Promise<RepositoryFileRow | null> {
  const rows = await db
    .select()
    .from(repositoryFiles)
    .where(and(eq(repositoryFiles.repositoryId, repositoryId), eq(repositoryFiles.path, path)))
  return rows[0] ?? null
}

/**
 * How a file's derived index (symbols, outline, vectors) stands against its
 * stored content (#471): `pending` while its extraction is queued, running or
 * not yet scheduled, `failed` when it gave up (the previous rows stay), null
 * when current. The same rule as `extractionState`, for one file.
 */
export type FileIndexState = 'pending' | 'failed' | null

export interface RepositoryFileRead {
  file: RepositoryFileRow
  version: IndexedVersion
  index: FileIndexState
}

/** A file for `read_file`, with its repository's indexed version and its index state, in one query. */
export async function readRepositoryFile(repositoryId: string, path: string): Promise<RepositoryFileRead | null> {
  const f = alias(repositoryFiles, 'f')
  const j = alias(jobs, 'j')
  const [row] = await db
    .select({
      file: f,
      lastSyncedCommit: repositories.lastSyncedCommit,
      treeHash: repositories.treeHash,
      index: sql<FileIndexState>`CASE
        WHEN ${j.id} IS NOT NULL AND ${j.doneAt} IS NULL OR ${j.id} IS NULL AND NOT ${hasCurrentBlocksSql()} THEN 'pending'
        WHEN ${j.doneAt} IS NOT NULL AND ${j.lastError} IS NOT NULL THEN 'failed'
      END`,
    })
    .from(f)
    .innerJoin(repositories, eq(repositories.id, f.repositoryId))
    .leftJoin(j, sql`${j.idempotencyKey} = ${extractionJobKeySql(sql`f.id`, sql`f.content_hash`)}`)
    .where(and(eq(f.repositoryId, repositoryId), eq(f.path, path)))
  return row ? { file: row.file, version: indexedVersion(row), index: row.index } : null
}

export async function listRepositoryFiles(
  repositoryId: string,
): Promise<Array<Pick<RepositoryFileRow, 'id' | 'path' | 'language' | 'size' | 'updatedAt'>>> {
  return db
    .select({
      id: repositoryFiles.id,
      path: repositoryFiles.path,
      language: repositoryFiles.language,
      size: repositoryFiles.size,
      updatedAt: repositoryFiles.updatedAt,
    })
    .from(repositoryFiles)
    .where(eq(repositoryFiles.repositoryId, repositoryId))
}

/**
 * One page of a repository's files for `browse_repository` (#424), in path
 * order by UTF-8 byte (`COLLATE "C"`, the index 0029 adds): the files under
 * `folder` (all of them when null) whose path sorts after `after`, at most
 * `limit` of them. The subtree is the range `folder/` ≤ path < `folder0`
 * ('0' is the byte after '/'), which needs no LIKE escaping. REST's
 * `listRepositoryFiles` stays whole and unordered.
 */
export async function listRepositoryFilesPage(
  repositoryId: string,
  opts: { folder: string | null; after: string | null; limit: number },
): Promise<Array<Pick<RepositoryFileRow, 'id' | 'path' | 'language' | 'size' | 'updatedAt'>>> {
  const path = sql`${repositoryFiles.path} collate "C"`
  const where: SQL[] = [eq(repositoryFiles.repositoryId, repositoryId)]
  if (opts.folder !== null) where.push(sql`${path} >= ${`${opts.folder}/`}`, sql`${path} < ${`${opts.folder}0`}`)
  if (opts.after !== null) where.push(sql`${path} > ${opts.after}`)
  return db
    .select({
      id: repositoryFiles.id,
      path: repositoryFiles.path,
      language: repositoryFiles.language,
      size: repositoryFiles.size,
      updatedAt: repositoryFiles.updatedAt,
    })
    .from(repositoryFiles)
    .where(and(...where))
    .orderBy(path)
    .limit(opts.limit)
}

/** Whether `path` is an indexed file, and the directories of the repository (at most 2,000, by path): what a folder that holds nothing is told (#1102). */
export async function folderProbe(repositoryId: string, path: string): Promise<{ isFile: boolean; directories: string[] }> {
  const [file] = await db.select({ id: repositoryFiles.id }).from(repositoryFiles).where(and(eq(repositoryFiles.repositoryId, repositoryId), eq(repositoryFiles.path, path)))
  const rows = (await db.execute(sql`
    SELECT dir FROM (SELECT DISTINCT regexp_replace(path, '/[^/]*$', '') AS dir FROM repository_files
    WHERE repository_id = ${repositoryId} AND position('/' IN path) > 0 ) d ORDER BY dir COLLATE "C" LIMIT 2000`)) as unknown as Array<{ dir: string }>
  return { isFile: file !== undefined, directories: rows.map((r) => r.dir) }
}

/**
 * A file's declared symbols — its "outline" (spec 9): its `symbol` blocks
 * (#413); `parent` only on a method or namespace member (#450).
 */
export async function listFileSymbols(
  fileId: string,
): Promise<Array<{ name: string; kind: string; parent?: string; startLine: number; endLine: number }>> {
  const rows = await db
    .select({
      innerPath: blocks.innerPath,
      kind: blocks.symbolKind,
      parent: blocks.symbolParent,
      startLine: blocks.startLine,
      endLine: blocks.endLine,
    })
    .from(blocks)
    .where(and(eq(blocks.ownerType, 'code'), eq(blocks.ownerId, fileId), eq(blocks.kind, 'symbol')))
    // Line order: an upsert moves heap rows, so without this the outline comes back in any order.
    .orderBy(asc(blocks.startLine), asc(blocks.blockId))
  return rows.map(({ innerPath, kind, parent, startLine, endLine }) => ({
    name: parent === null ? innerPath : innerPath.slice(parent.length + 1),
    kind: kind!, // set on every symbol block
    ...(parent === null ? {} : { parent }),
    startLine,
    endLine,
  }))
}

/**
 * The blocks of a file's current content (#416, #417): those extraction
 * wrote for `contentHash` (`owner_version`), in line order, so a read never
 * serves the lines of a symbol from content a push has since replaced.
 * `stale`: the file has blocks, but of older content (extraction is behind).
 */
export async function listFileBlocks(
  fileId: string,
  contentHash: string,
): Promise<{ blocks: Array<{ blockId: string; kind: string; innerPath: string; symbolKind: string | null; startLine: number; endLine: number }>; stale: boolean }> {
  const rows = await db
    .select({
      blockId: blocks.blockId,
      kind: blocks.kind,
      innerPath: blocks.innerPath,
      symbolKind: blocks.symbolKind,
      startLine: blocks.startLine,
      endLine: blocks.endLine,
      ownerVersion: blocks.ownerVersion,
    })
    .from(blocks)
    .where(and(eq(blocks.ownerType, 'code'), eq(blocks.ownerId, fileId)))
    .orderBy(asc(blocks.startLine), asc(blocks.blockId))
  const current = rows.filter((row) => row.ownerVersion === contentHash)
  return { blocks: current, stale: current.length < rows.length }
}
