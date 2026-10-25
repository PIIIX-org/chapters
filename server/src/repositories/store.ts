import { createHash } from 'node:crypto'
import { and, asc, eq, notInArray, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { blocks, repositoryFiles } from '../db/schema.js'
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
 * The one write path for repository file content (spec 8): every
 * ingestion method funnels through here. `contentHash` is always
 * computed server-side from the stored `content` (NUL bytes removed first:
 * stored text = hashed text, #418) — never trusted from a caller,
 * since the server is the single source of truth regardless of how the
 * content arrived.
 */
export async function syncRepositoryFiles(
  repositoryId: string,
  changedOrNewFiles: FileUpdate[],
  currentPaths: string[],
): Promise<SyncResult> {
  const existing = await db
    .select({ id: repositoryFiles.id, path: repositoryFiles.path, contentHash: repositoryFiles.contentHash })
    .from(repositoryFiles)
    .where(eq(repositoryFiles.repositoryId, repositoryId))
  const existingByPath = new Map(existing.map((r) => [r.path, r]))

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
  }

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
