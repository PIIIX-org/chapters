import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositoryFileImports, repositoryFileSymbols, repositoryFiles } from '../db/schema.js'
import { embedder } from '../search/embeddings.js'
import { recomputeSemanticEdges } from '../search/semantic-edges.js'
import { vectorStore } from '../search/vector/index.js'
import { extractStructure, isSupportedLanguage } from './extraction.js'
import { resolveImportPath } from './import-resolution.js'

// ponytail: in-process serial queue; move to a job table if multi-process
const queue: string[] = []
let running: Promise<void> | null = null

// ponytail: repo path cache to eliminate N*N sibling queries during batch extraction (DB-09).
const repoSiblingsCache = new Map<string, { pathToId: Map<string, string>; knownPaths: Set<string> }>()

async function getRepoSiblings(repositoryId: string) {
  let cached = repoSiblingsCache.get(repositoryId)
  if (!cached) {
    const siblings = await db
      .select({ id: repositoryFiles.id, path: repositoryFiles.path })
      .from(repositoryFiles)
      .where(eq(repositoryFiles.repositoryId, repositoryId))
    cached = {
      pathToId: new Map(siblings.map((s) => [s.path, s.id])),
      knownPaths: new Set(siblings.map((s) => s.path)),
    }
    repoSiblingsCache.set(repositoryId, cached)
  }
  return cached
}

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
  let head = 0
  try {
    while (head < queue.length) {
      const fileId = queue[head++]!
      try {
        await processFile(fileId)
      } catch (err) {
        console.error(`extraction failed for repository file ${fileId}:`, err)
      }
      // ponytail: O(1) amortized compaction to avoid O(N^2) array shifting (INGEST-02).
      if (head > 1000 && head > queue.length / 2) {
        queue.splice(0, head)
        head = 0
      }
    }
  } finally {
    queue.length = 0
    repoSiblingsCache.clear()
  }
}

async function processFile(fileId: string): Promise<void> {
  const row = (await db.select().from(repositoryFiles).where(eq(repositoryFiles.id, fileId)))[0]
  if (!row) return

  if (isSupportedLanguage(row.language)) {
    const { imports, symbols } = await extractStructure(row.language, row.content)

    const { pathToId, knownPaths } = await getRepoSiblings(row.repositoryId)

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
    let symbolPayloads: Array<{
      fileId: string
      name: string
      kind: string
      startLine: number
      endLine: number
      snippet: string
      embedText: string
    }> = []

    if (symbols.length > 0) {
      const fileLines = row.content.split('\n')
      symbolPayloads = symbols.map((s) => {
        const snippetLines = fileLines.slice(s.startLine - 1, s.endLine)
        const snippet = snippetLines.slice(0, 30).join('\n').slice(0, 1500)
        return {
          fileId,
          name: s.name,
          kind: s.kind,
          startLine: s.startLine,
          endLine: s.endLine,
          snippet,
          embedText: `${s.kind} ${s.name} in ${row.path}:${s.startLine}\n${snippet}`,
        }
      })
    }

    // ponytail: batch embeddings and symbol inserts <= 1,000 to prevent Postgres parameter overflow (INGEST-06)
    const SYMBOL_BATCH_SIZE = 1000
    const allTexts = [`${row.path}\n${row.content}`, ...symbolPayloads.map((s) => s.embedText)]

    const allEmbeddings: number[][] = []
    for (let i = 0; i < allTexts.length; i += SYMBOL_BATCH_SIZE) {
      const textChunk = allTexts.slice(i, i + SYMBOL_BATCH_SIZE)
      const chunkEmbeddings = await embedder.embed(textChunk)
      allEmbeddings.push(...chunkEmbeddings)
    }
    const fileEmbedding = allEmbeddings[0]!
    const symbolEmbeddings = allEmbeddings.slice(1)

    if (symbolPayloads.length > 0) {
      const insertedIds: string[] = []
      for (let i = 0; i < symbolPayloads.length; i += SYMBOL_BATCH_SIZE) {
        const batchPayloads = symbolPayloads.slice(i, i + SYMBOL_BATCH_SIZE)
        const batchInserted = await db
          .insert(repositoryFileSymbols)
          .values(
            batchPayloads.map((s) => ({
              fileId: s.fileId,
              name: s.name,
              kind: s.kind,
              startLine: s.startLine,
              endLine: s.endLine,
              snippet: s.snippet,
            })),
          )
          .returning({ id: repositoryFileSymbols.id })
        for (const item of batchInserted) {
          insertedIds.push(item.id)
        }
      }

      for (let i = 0; i < insertedIds.length; i += SYMBOL_BATCH_SIZE) {
        const batchIds = insertedIds.slice(i, i + SYMBOL_BATCH_SIZE)
        const batchPayloads = symbolPayloads.slice(i, i + SYMBOL_BATCH_SIZE)
        const batchEmbeddings = symbolEmbeddings.slice(i, i + SYMBOL_BATCH_SIZE)

        await vectorStore.upsertSymbols(
          batchIds.map((id, j) => ({
            id,
            embedding: batchEmbeddings[j]!,
            meta: {
              fileId: batchPayloads[j]!.fileId,
              repositoryId: row.repositoryId,
              name: batchPayloads[j]!.name,
              kind: batchPayloads[j]!.kind,
              path: row.path,
              startLine: batchPayloads[j]!.startLine,
              endLine: batchPayloads[j]!.endLine,
            },
            snippet: batchPayloads[j]!.snippet ?? undefined,
          })),
        )
      }
    }

    await vectorStore.upsertFile(
      fileId,
      fileEmbedding,
      { repositoryId: row.repositoryId, path: row.path, language: row.language },
      row.content,
    )
    await db.update(repositoryFiles).set({ embeddedAt: new Date() }).where(eq(repositoryFiles.id, fileId))
    await recomputeSemanticEdges('code', fileId, fileEmbedding)
    return
  }

  const [embedding] = await embedder.embed([`${row.path}\n${row.content}`])
  if (embedding) {
    await vectorStore.upsertFile(
      fileId,
      embedding,
      { repositoryId: row.repositoryId, path: row.path, language: row.language },
      row.content,
    )
    await db.update(repositoryFiles).set({ embeddedAt: new Date() }).where(eq(repositoryFiles.id, fileId))
    await recomputeSemanticEdges('code', fileId, embedding)
  }
}
