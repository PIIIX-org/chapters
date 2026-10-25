import { createHash } from 'node:crypto'
import { and, asc, eq, notInArray, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { blocks, repositories, repositoryFiles } from '../db/schema.js'
import { deleteSemanticEdgesFor } from '../search/semantic-edges.js'
import { detectLanguage } from './language.js'
import { enqueueExtractions, scheduleImportReresolution } from './extraction-queue.js'
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
      await db.update(repositoryFiles).set(values).where(eq(repositoryFiles.id, current.id))
      toExtract.push(current.id)
      result.updated += 1
    } else {
      const [inserted] = await db
        .insert(repositoryFiles)
        .values(values)
        .onConflictDoUpdate({
          target: [repositoryFiles.repositoryId, repositoryFiles.path],
          set: values,
        })
        .returning({ id: repositoryFiles.id })
      if (inserted) toExtract.push(inserted.id)
      result.created += 1
    }
    if (isResolutionManifest(file.path)) manifestChanged = true
  }

  const currentPathSet = new Set(currentPaths)
  const toDelete = existing.filter((r) => !currentPathSet.has(r.path))
  if (toDelete.length > 0) {
    await db.delete(repositoryFiles).where(
      and(
        eq(repositoryFiles.repositoryId, repositoryId),
        notInArray(
          repositoryFiles.path,
          currentPaths.length > 0 ? currentPaths : ['__empty_repository_path__'],
        ),
      ),
    )
    // Same as notes: semanticEdges has no FK and does not cascade (#92).
    await deleteSemanticEdgesFor('code', toDelete.map((r) => r.id))
    result.deleted = toDelete.length
    if (toDelete.some((r) => isResolutionManifest(r.path))) manifestChanged = true
    // The delete also takes a batch file outside currentPaths.
    for (const path of hashByPath.keys()) if (!currentPathSet.has(path)) hashByPath.delete(path)
  }

  await db
    .update(repositories)
    .set({
      treeHash: computeTreeHash(hashByPath),
      ...(indexed.commit !== undefined ? { lastSyncedCommit: indexed.commit } : {}),
    })
    .where(eq(repositories.id, repositoryId))

  if (manifestChanged) scheduleImportReresolution(repositoryId)

  await enqueueExtractions(toExtract)
  checkCodeStaleness(repositoryId).catch(console.error)

  return result
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
 * order by code unit (`COLLATE "C"`, the index 0029 adds): the files under
 * `folder` (all of them when null) whose path sorts after `after`, at most
 * `limit` of them. The subtree is the range `folder/` ≤ path < `folder0`
 * ('0' is the code unit after '/'), which needs no LIKE escaping. REST's
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
