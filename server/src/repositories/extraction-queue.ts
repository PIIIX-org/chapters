import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositoryFileImports, repositoryFileSymbols, repositoryFiles } from '../db/schema.js'
import { embedder } from '../search/embeddings.js'
import { recomputeSemanticEdges } from '../search/semantic-edges.js'
import { extractStructure, isSupportedLanguage } from './extraction.js'
import { resolveImportPath } from './import-resolution.js'

// ponytail: in-process serial queue; move to a job table if multi-process
const queue: string[] = []
let running: Promise<void> | null = null

/** Enqueue a repository file for extraction + embedding. Never blocks the caller. */
export function scheduleExtraction(fileId: string): void {
  queue.push(fileId)
  running ??= drain().finally(() => {
    running = null
  })
}

export async function flushExtraction(): Promise<void> {
  while (running) await running
}

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const fileId = queue.shift()!
    try {
      await processFile(fileId)
    } catch (err) {
      console.error(`extraction failed for repository file ${fileId}:`, err)
    }
  }
}

async function processFile(fileId: string): Promise<void> {
  const row = (await db.select().from(repositoryFiles).where(eq(repositoryFiles.id, fileId)))[0]
  if (!row) return

  if (isSupportedLanguage(row.language)) {
    const { imports, symbols } = await extractStructure(row.language, row.content)

    const siblings = await db
      .select({ id: repositoryFiles.id, path: repositoryFiles.path })
      .from(repositoryFiles)
      .where(eq(repositoryFiles.repositoryId, row.repositoryId))
    const pathToId = new Map(siblings.map((s) => [s.path, s.id]))
    const knownPaths = new Set(siblings.map((s) => s.path))

    await db.delete(repositoryFileImports).where(eq(repositoryFileImports.sourceFileId, fileId))
    if (imports.length > 0) {
      const rows = imports.map((targetPath) => {
        const resolved = resolveImportPath(row.path, targetPath, knownPaths)
        return {
          sourceFileId: fileId,
          targetPath,
          resolvedTargetFileId: resolved ? pathToId.get(resolved) : undefined,
        }
      })
      await db.insert(repositoryFileImports).values(rows).onConflictDoNothing()
    }

    await db.delete(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, fileId))
    if (symbols.length > 0) {
      await db.insert(repositoryFileSymbols).values(
        symbols.map((s) => ({
          fileId,
          name: s.name,
          kind: s.kind,
          startLine: s.startLine,
          endLine: s.endLine,
        })),
      )
    }
  }

  const [embedding] = await embedder.embed([`${row.path}\n${row.content}`])
  await db.update(repositoryFiles).set({ embedding }).where(eq(repositoryFiles.id, fileId))
  await recomputeSemanticEdges('code', fileId, embedding!)
}
