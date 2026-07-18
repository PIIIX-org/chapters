import { createHash } from 'node:crypto'
import { and, eq, notInArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositoryFiles, repositoryFileSymbols } from '../db/schema.js'
import { detectLanguage } from './language.js'
import { scheduleExtraction } from './extraction-queue.js'

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
 * computed server-side from `content` — never trusted from a caller,
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

  for (const file of changedOrNewFiles) {
    const contentHash = createHash('sha256').update(file.content).digest('hex')
    const current = existingByPath.get(file.path)
    if (current && current.contentHash === contentHash) {
      result.unchanged += 1
      continue
    }
    const values = {
      repositoryId,
      path: file.path,
      language: detectLanguage(file.path),
      content: file.content,
      contentHash,
      size: Buffer.byteLength(file.content, 'utf8'),
      sourceModifiedAt: file.sourceModifiedAt,
      updatedAt: new Date(),
    }
    if (current) {
      await db.update(repositoryFiles).set(values).where(eq(repositoryFiles.id, current.id))
      toExtract.push(current.id)
      result.updated += 1
    } else {
      const [inserted] = await db.insert(repositoryFiles).values(values).returning({ id: repositoryFiles.id })
      toExtract.push(inserted!.id)
      result.created += 1
    }
  }

  const currentPathSet = new Set(currentPaths)
  const toDelete = existing.filter((r) => !currentPathSet.has(r.path))
  if (toDelete.length > 0) {
    await db.delete(repositoryFiles).where(
      and(
        eq(repositoryFiles.repositoryId, repositoryId),
        notInArray(
          repositoryFiles.path,
          currentPaths.length > 0 ? currentPaths : ['\0-impossible-path-\0'],
        ),
      ),
    )
    result.deleted = toDelete.length
  }

  for (const id of toExtract) scheduleExtraction(id)

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

/** Declared top-level symbols for a file — its "outline" (spec 9). */
export async function listFileSymbols(
  fileId: string,
): Promise<Array<Pick<typeof repositoryFileSymbols.$inferSelect, 'name' | 'kind' | 'startLine' | 'endLine'>>> {
  return db
    .select({
      name: repositoryFileSymbols.name,
      kind: repositoryFileSymbols.kind,
      startLine: repositoryFileSymbols.startLine,
      endLine: repositoryFileSymbols.endLine,
    })
    .from(repositoryFileSymbols)
    .where(eq(repositoryFileSymbols.fileId, fileId))
}
