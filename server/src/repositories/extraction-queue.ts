import { and, eq, isNull, sql } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { repositoryFileImports, repositoryFileSymbols, repositoryFiles } from '../db/schema.js'
import { embedder } from '../search/embeddings.js'
import { recomputeSemanticEdges } from '../search/semantic-edges.js'
import { extractStructure, isSupportedLanguage, type ExtractionResult } from './extraction.js'
import { resolveImportPath } from './import-resolution.js'
import { recordJob } from '../monitoring/metrics.js'
import {
  MAX_JOB_ATTEMPTS,
  claimJob,
  completeJob,
  failCrashedJobs,
  failJob,
  jobDrainer,
  onJobConflict,
  type JobRerun,
} from '../jobs/durable.js'

/**
 * Extraction runs from durable `jobs` rows (#494, ADR-003 S5; see
 * jobs/durable.ts): kind `extract`, payload `{fileId, repositoryId}`, key
 * `extract:<fileId>:<contentHash>`. Fair across repositories (#497): each turn
 * claims at most `EXTRACTION_TURN_FILES` jobs of one repository, then the
 * repository with claimable jobs that was served least recently goes next
 * (ties: the oldest job). A large repository's backlog therefore delays
 * another repository's files by at most one turn, and a repository's own
 * files keep their enqueue order.
 */
const EXTRACTION_TURN_FILES = 10
export const EXTRACTION_JOB = 'extract'
/** Turn number each repository last got; repositories never served count as 0. */
const lastTurn = new Map<string, number>()
let turn = 0

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

/** Inserts extraction jobs for these files at their current content, in this order (a repeated id counts once). */
export async function enqueueExtractions(fileIds: string[], rerun: JobRerun = 'succeeded'): Promise<void> {
  if (fileIds.length === 0) return
  // A push may list one path twice; ON CONFLICT DO UPDATE refuses a key twice in one statement.
  const ids = [...new Set(fileIds)]
  await db.execute(sql`
    INSERT INTO jobs (kind, payload, idempotency_key)
    SELECT ${EXTRACTION_JOB}, jsonb_build_object('fileId', f.id::text, 'repositoryId', f.repository_id::text),
      ${EXTRACTION_JOB} || ':' || f.id || ':' || f.content_hash
    FROM unnest(${`{${ids.join(',')}}`}::uuid[]) WITH ORDINALITY AS u(id, ord)
    JOIN repository_files f ON f.id = u.id
    ORDER BY u.ord
    ${onJobConflict(rerun)}`)
  extraction.kick()
}

/**
 * Enqueue a repository file for extraction + embedding. Never blocks the
 * caller. Callers enqueue on a content change, so a file whose content went
 * back to an earlier version is extracted again; a failed job stays failed.
 */
export function scheduleExtraction(fileId: string): void {
  extraction.track(enqueueExtractions([fileId]))
}

export async function flushExtraction(): Promise<void> {
  await extraction.flush()
}

/**
 * Re-resolve stored imports that have no target yet, from their raw
 * `target_path` (no re-parse). Extraction only re-runs when content
 * changes, so rows written by an older resolver stay unresolved until
 * this runs. Idempotent; called once at startup. Returns rows resolved.
 */
export async function backfillUnresolvedImports(): Promise<number> {
  const pending = await db
    .select({
      sourceFileId: repositoryFileImports.sourceFileId,
      targetPath: repositoryFileImports.targetPath,
      sourcePath: repositoryFiles.path,
      repositoryId: repositoryFiles.repositoryId,
    })
    .from(repositoryFileImports)
    .innerJoin(repositoryFiles, eq(repositoryFiles.id, repositoryFileImports.sourceFileId))
    .where(isNull(repositoryFileImports.resolvedTargetFileId))

  const siblingsByRepo = new Map<string, { pathToId: Map<string, string>; knownPaths: Set<string> }>()
  let resolvedCount = 0
  for (const imp of pending) {
    let siblings = siblingsByRepo.get(imp.repositoryId)
    if (!siblings) {
      const files = await db
        .select({ id: repositoryFiles.id, path: repositoryFiles.path })
        .from(repositoryFiles)
        .where(eq(repositoryFiles.repositoryId, imp.repositoryId))
      siblings = { pathToId: new Map(files.map((f) => [f.path, f.id])), knownPaths: new Set(files.map((f) => f.path)) }
      siblingsByRepo.set(imp.repositoryId, siblings)
    }
    const resolved = resolveImportPath(imp.sourcePath, imp.targetPath, siblings.knownPaths)
    const targetId = resolved ? siblings.pathToId.get(resolved) : undefined
    if (!targetId) continue
    await db
      .update(repositoryFileImports)
      .set({ resolvedTargetFileId: targetId })
      .where(
        and(
          eq(repositoryFileImports.sourceFileId, imp.sourceFileId),
          eq(repositoryFileImports.targetPath, imp.targetPath),
        ),
      )
    resolvedCount++
  }
  return resolvedCount
}

/**
 * Boot catch-up: enqueue every file with a null embedding (its extraction
 * never completed) and wake the worker, which also reclaims jobs whose lease
 * a dead process left. Idempotent: a pending job is left as it is. A job that
 * failed with an error runs again (the outage that failed it may be over, as
 * a restart repaired it before #494); one whose runs ended with the process
 * (`LeaseExpired`) does not, so a crash loop is not restarted at every boot.
 * Returns the files found.
 */
export async function scheduleMissingExtractions(): Promise<number> {
  const missing = await db
    .select({ id: repositoryFiles.id })
    .from(repositoryFiles)
    .where(isNull(repositoryFiles.embedding))
    .orderBy(repositoryFiles.repositoryId, repositoryFiles.path)
  await enqueueExtractions(
    missing.map((r) => r.id),
    'errored',
  )
  extraction.kick()
  return missing.length
}

/**
 * Files of a repository whose extraction for their current content is still
 * to come: a pending (queued or running) job, or no job and no embedding
 * (written before the jobs table; the boot scan adds its job). Failed files
 * are not counted: `extractionFailures` lists them. 0 = extraction finished.
 */
export async function countPendingExtractions(repositoryId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS pending
    FROM repository_files f
    LEFT JOIN jobs j ON j.idempotency_key = ${EXTRACTION_JOB} || ':' || f.id || ':' || f.content_hash
    WHERE f.repository_id = ${repositoryId}
      AND (j.id IS NOT NULL AND j.done_at IS NULL OR j.id IS NULL AND f.embedding IS NULL)`)) as unknown as [{ pending: number }]
  return row?.pending ?? 0
}

/**
 * Files whose extraction job for their current content gave up after
 * `MAX_JOB_ATTEMPTS`: the total and the first `limit` by path with the error.
 */
export async function extractionFailures(
  repositoryId: string,
  limit = 5,
): Promise<{ total: number; files: Array<{ path: string; attempts: number; lastError: string }> }> {
  const rows = (await db.execute(sql`
    SELECT f.path, j.attempts, j.last_error AS "lastError", count(*) OVER () AS total
    FROM repository_files f
    JOIN jobs j ON j.idempotency_key = ${EXTRACTION_JOB} || ':' || f.id || ':' || f.content_hash
    WHERE f.repository_id = ${repositoryId} AND j.done_at IS NOT NULL AND j.last_error IS NOT NULL
    ORDER BY f.path
    LIMIT ${limit}`)) as unknown as Array<{ path: string; attempts: number; lastError: string; total: string | number }>
  return {
    total: Number(rows[0]?.total ?? 0),
    files: rows.map(({ path, attempts, lastError }) => ({ path, attempts, lastError })),
  }
}

/** The next repository to get a turn: least recently served, then oldest claimable job. */
async function nextRepository(): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT payload->>'repositoryId' AS "repositoryId", min(id) AS first
    FROM jobs
    WHERE kind = ${EXTRACTION_JOB} AND done_at IS NULL AND (lease_until IS NULL OR lease_until < now())
      AND attempts < ${MAX_JOB_ATTEMPTS}
    GROUP BY 1`)) as unknown as Array<{ repositoryId: string; first: string | number }>
  let best: { repositoryId: string; turn: number; first: number } | null = null
  for (const row of rows) {
    const candidate = { repositoryId: row.repositoryId, turn: lastTurn.get(row.repositoryId) ?? 0, first: Number(row.first) }
    if (!best || candidate.turn < best.turn || (candidate.turn === best.turn && candidate.first < best.first)) best = candidate
  }
  return best?.repositoryId ?? null
}

async function drainOnce(): Promise<void> {
  try {
    await failCrashedJobs(EXTRACTION_JOB, 'extraction', 'fileId')
    for (;;) {
      const repositoryId = await nextRepository()
      if (!repositoryId) return
      lastTurn.set(repositoryId, ++turn)
      for (let n = 0; n < EXTRACTION_TURN_FILES; n++) {
        const job = await claimJob<{ fileId: string }>(EXTRACTION_JOB, sql`payload->>'repositoryId' = ${repositoryId}`)
        if (!job) break
        const { fileId } = job.payload
        try {
          await processFile(fileId)
          await completeJob(job.id)
          recordJob('extraction', 'ok', fileId)
        } catch (err) {
          console.error(
            `extraction failed for repository file ${fileId} (attempt ${job.attempts}/${MAX_JOB_ATTEMPTS}):`,
            err,
          )
          await failJob(job, err, 'extraction', fileId)
        }
      }
    }
  } finally {
    repoSiblingsCache.clear()
  }
}

const extraction = jobDrainer('extraction', drainOnce)

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

    // Per-file budget (#496): the file and its first N symbols get a vector,
    // the rest are stored without one, so one file with thousands of
    // declarations neither holds the queue for minutes nor loses its structure.
    const budget = config.embedMaxSymbolsPerFile
    const embedded = symbolPayloads.slice(0, budget)
    let embeddingNote: string | null = null
    if (symbolPayloads.length > budget) {
      embeddingNote = `symbol embeddings capped by ELARA_EMBED_MAX_SYMBOLS_PER_FILE: ${budget} of ${symbolPayloads.length} symbols embedded, the rest are keyword-searchable only`
      console.warn(`[extraction] ${row.path} (repository file ${fileId}): ${embeddingNote}`)
    }
    const allTexts = [`${row.path}\n${row.content}`, ...embedded.map((s) => s.embedText)]
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
          embedding: symbolEmbeddings[i] ?? null,
        })),
      )
    }

    await db
      .update(repositoryFiles)
      .set({ embedding: fileEmbedding, embeddingNote })
      .where(eq(repositoryFiles.id, fileId))
    await recomputeSemanticEdges('code', fileId, fileEmbedding)
    return
  }

  const [embedding] = await embedder.embed([`${row.path}\n${row.content}`])
  await db.update(repositoryFiles).set({ embedding, embeddingNote: null }).where(eq(repositoryFiles.id, fileId))
  await recomputeSemanticEdges('code', fileId, embedding!)
}
