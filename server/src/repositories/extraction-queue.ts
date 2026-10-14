import { and, count, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositoryFileImports, repositoryFileSymbols, repositoryFiles } from '../db/schema.js'
import { embedder } from '../search/embeddings.js'
import { recomputeSemanticEdges } from '../search/semantic-edges.js'
import { extractStructure, isSupportedLanguage, type ExtractionResult } from './extraction.js'
import { resolveImportPath } from './import-resolution.js'

// ponytail: in-process serial queue; move to a job table if multi-process
const queue: string[] = []
let running: Promise<void> | null = null

/**
 * A line this long means minified, bundled or generated code (prettier-style
 * source stays far below it). Tree-sitter parses such files fine (742 KB
 * bundle: ~190 ms), but every declaration in it starts on the same few lines,
 * so its symbols are minified names with snippets cut from one huge line —
 * hundreds of meaningless rows, each costing an embedding. Such a file keeps
 * its content, file embedding and keyword search, but gets no symbols/imports.
 */
const MAX_STRUCTURED_LINE_LENGTH = 1000

function looksMinified(content: string): boolean {
  let lineStart = 0
  while (lineStart < content.length) {
    let lineEnd = content.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = content.length
    if (lineEnd - lineStart > MAX_STRUCTURED_LINE_LENGTH) return true
    lineStart = lineEnd + 1
  }
  return false
}

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
  running ??= drain()
}

export async function flushExtraction(): Promise<void> {
  while (running) await running
}

/**
 * Boot catch-up: the queue lives in memory, so files enqueued when the
 * process stopped are lost — and a re-sync never re-enqueues them, because
 * their content hash is unchanged. A file gets its embedding as the last step
 * of extraction, so a null embedding means extraction never completed.
 */
export async function scheduleMissingExtractions(): Promise<number> {
  const missing = await db
    .select({ id: repositoryFiles.id })
    .from(repositoryFiles)
    .where(isNull(repositoryFiles.embedding))
    .orderBy(repositoryFiles.repositoryId)
  for (const row of missing) scheduleExtraction(row.id)
  return missing.length
}

/** Files of a repository whose extraction has not completed (queued, lost or failed). */
export async function countPendingExtractions(repositoryId: string): Promise<number> {
  const [row] = await db
    .select({ pending: count() })
    .from(repositoryFiles)
    .where(and(eq(repositoryFiles.repositoryId, repositoryId), isNull(repositoryFiles.embedding)))
  return row?.pending ?? 0
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
    // Cleared here, in the same synchronous step that saw the queue empty: a
    // `.finally()` on the caller's side would run a microtask later, and a file
    // enqueued in between would find `running` still set and start no drain.
    running = null
  }
}

async function processFile(fileId: string): Promise<void> {
  const row = (await db.select().from(repositoryFiles).where(eq(repositoryFiles.id, fileId)))[0]
  if (!row) return

  if (isSupportedLanguage(row.language)) {
    // A minified file still clears the imports/symbols an earlier version left.
    const { imports, symbols }: ExtractionResult = looksMinified(row.content)
      ? { imports: [], symbols: [] }
      : await extractStructure(row.language, row.content)

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

    const allTexts = [`${row.path}\n${row.content}`, ...symbolPayloads.map((s) => s.embedText)]
    const allEmbeddings = await embedder.embed(allTexts)
    const fileEmbedding = allEmbeddings[0]!
    const symbolEmbeddings = allEmbeddings.slice(1)

    if (symbolPayloads.length > 0) {
      await db.insert(repositoryFileSymbols).values(
        symbolPayloads.map((s, i) => ({
          fileId: s.fileId,
          name: s.name,
          kind: s.kind,
          startLine: s.startLine,
          endLine: s.endLine,
          snippet: s.snippet,
          embedding: symbolEmbeddings[i],
        })),
      )
    }

    await db.update(repositoryFiles).set({ embedding: fileEmbedding }).where(eq(repositoryFiles.id, fileId))
    await recomputeSemanticEdges('code', fileId, fileEmbedding)
    return
  }

  const [embedding] = await embedder.embed([`${row.path}\n${row.content}`])
  await db.update(repositoryFiles).set({ embedding }).where(eq(repositoryFiles.id, fileId))
  await recomputeSemanticEdges('code', fileId, embedding!)
}
