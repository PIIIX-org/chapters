import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { repositoryFileImports, repositoryFileSymbols, repositoryFiles } from '../db/schema.js'
import { failpoint } from '../failpoints.js'
import { EMBEDDER_ID, embedder } from '../search/embeddings.js'
import { recomputeSemanticEdges } from '../search/semantic-edges.js'
import { EXTRACTOR_VERSION, extractStructure, isSupportedLanguage, type ExtractionResult } from './extraction.js'
import { resolveImportPath } from './import-resolution.js'
import { detectLanguage } from './language.js'
import { recordJob } from '../monitoring/metrics.js'
import {
  JOB_PRIORITY,
  MAX_JOB_ATTEMPTS,
  catchUpLimits,
  claimJob,
  completeJob,
  erroredJobExists,
  failCrashedJobs,
  failJob,
  jobDrainer,
  jobExists,
  onJobConflict,
  type JobPriority,
  type JobRerun,
} from '../jobs/durable.js'

/**
 * Extraction runs from durable `jobs` rows (#494, ADR-003 S5; see
 * jobs/durable.ts): kind `extract`, payload `{fileId, repositoryId}`, key
 * `extract:<fileId>:<contentHash>:<EXTRACTOR_VERSION>:<EMBEDDER_ID>` (#453).
 * Fair across repositories (#497): each turn
 * claims at most `EXTRACTION_TURN_FILES` jobs of one repository, then the
 * repository with claimable jobs that was served least recently goes next
 * (ties: the oldest job). A large repository's backlog therefore delays
 * another repository's files by at most one turn, and a repository's own
 * files keep their enqueue order.
 */
const EXTRACTION_TURN_FILES = 10
export const EXTRACTION_JOB = 'extract'

/** The key of the job that derives a file's content `contentHash` with the running extractor and embedder (#453). */
export function extractionJobKey(fileId: string, contentHash: string): string {
  return `${EXTRACTION_JOB}:${fileId}:${contentHash}:${EXTRACTOR_VERSION}:${EMBEDDER_ID}`
}

/** `extractionJobKey` in SQL, from a file row's `id` and `content_hash`. */
function extractionJobKeySql(id: SQL, contentHash: SQL): SQL {
  return sql`${EXTRACTION_JOB} || ':' || ${id} || ':' || ${contentHash} || ':' || ${`${EXTRACTOR_VERSION}:${EMBEDDER_ID}`}`
}

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

/**
 * Inserts extraction jobs for these files at their current content, in this
 * order (a repeated id counts once), at `priority` (a push's are `write`).
 */
export async function enqueueExtractions(
  fileIds: string[],
  rerun: JobRerun = 'succeeded',
  priority: JobPriority = JOB_PRIORITY.write,
): Promise<void> {
  if (fileIds.length === 0) return
  // A push may list one path twice; ON CONFLICT DO UPDATE refuses a key twice in one statement.
  const ids = [...new Set(fileIds)]
  await db.execute(sql`
    INSERT INTO jobs (kind, payload, idempotency_key, priority)
    SELECT ${EXTRACTION_JOB}, jsonb_build_object('fileId', f.id::text, 'repositoryId', f.repository_id::text),
      ${extractionJobKeySql(sql`f.id`, sql`f.content_hash`)}, ${priority}::smallint
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
 * Boot catch-up: enqueue every file whose derived rows are not those of its
 * current content by the running code (#453): no embedding, extracted from
 * another content hash (`extracted_hash`, e.g. a push the process died in
 * before it enqueued), or by another `EXTRACTOR_VERSION` or `EMBEDDER_ID` —
 * unless a job for that already exists — and every file whose job for the
 * current key failed with an error (an updated file keeps its previous rows).
 * Then wake the worker, which also reclaims jobs whose lease a dead process
 * left. Idempotent: a pending job is left as it is. A job that failed with an
 * error runs again (the outage that failed it may be over, as a restart
 * repaired it before #494); one whose runs ended with the process
 * (`LeaseExpired`) does not, so a crash loop is not restarted at every boot.
 * A version bump changes the key, so such a file gets one new job (3
 * attempts) per new extractor or embedder. Keyset pages of
 * `catchUpLimits.batchSize` files by repository and path, one SELECT and one
 * INSERT each, never one transaction for the whole instance. Returns the
 * files found.
 */
export async function scheduleMissingExtractions(): Promise<number> {
  const key = extractionJobKeySql(sql`f.id`, sql`f.content_hash`)
  const batchSize = catchUpLimits.batchSize
  let after: { repositoryId: string; path: string } | null = null
  let found = 0
  for (;;) {
    const page = (await db.execute(sql`
      SELECT f.id, f.repository_id AS "repositoryId", f.path FROM repository_files f
      WHERE ${after ? sql`(f.repository_id, f.path) > (${after.repositoryId}::uuid, ${after.path})` : sql`TRUE`}
        AND (
          ((f.embedding IS NULL OR f.extracted_hash IS DISTINCT FROM f.content_hash
            OR f.extractor_version <> ${EXTRACTOR_VERSION} OR f.embedder_id IS DISTINCT FROM ${EMBEDDER_ID})
            AND NOT ${jobExists(key)})
          OR ${erroredJobExists(key)})
      ORDER BY f.repository_id, f.path
      LIMIT ${batchSize}`)) as unknown as Array<{ id: string; repositoryId: string; path: string }>
    await enqueueExtractions(
      page.map((r) => r.id),
      'errored',
      JOB_PRIORITY.catchUp,
    )
    found += page.length
    if (page.length < batchSize) break
    after = page.at(-1)!
  }
  extraction.kick()
  return found
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
    LEFT JOIN jobs j ON j.idempotency_key = ${extractionJobKeySql(sql`f.id`, sql`f.content_hash`)}
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
    JOIN jobs j ON j.idempotency_key = ${extractionJobKeySql(sql`f.id`, sql`f.content_hash`)}
    WHERE f.repository_id = ${repositoryId} AND j.done_at IS NOT NULL AND j.last_error IS NOT NULL
    ORDER BY f.path
    LIMIT ${limit}`)) as unknown as Array<{ path: string; attempts: number; lastError: string; total: string | number }>
  return {
    total: Number(rows[0]?.total ?? 0),
    files: rows.map(({ path, attempts, lastError }) => ({ path, attempts, lastError })),
  }
}

/** Claimable `extract` jobs (row alias `jobs`). */
const claimable = sql`kind = ${EXTRACTION_JOB} AND done_at IS NULL AND (lease_until IS NULL OR lease_until < now())
  AND attempts < ${MAX_JOB_ATTEMPTS}`

/**
 * The next turn: among the repositories with claimable jobs of the lowest
 * priority present (a push's before catch-up, #453), the least recently
 * served, then the one with the oldest such job.
 */
async function nextRepository(): Promise<{ repositoryId: string; priority: JobPriority } | null> {
  const rows = (await db.execute(sql`
    SELECT payload->>'repositoryId' AS "repositoryId", priority, min(id) AS first
    FROM jobs
    WHERE ${claimable} AND priority = (SELECT min(priority) FROM jobs WHERE ${claimable})
    GROUP BY 1, 2`)) as unknown as Array<{ repositoryId: string; priority: JobPriority; first: string | number }>
  let best: { repositoryId: string; priority: JobPriority; turn: number; first: number } | null = null
  for (const row of rows) {
    const candidate = { ...row, turn: lastTurn.get(row.repositoryId) ?? 0, first: Number(row.first) }
    if (!best || candidate.turn < best.turn || (candidate.turn === best.turn && candidate.first < best.first)) best = candidate
  }
  return best && { repositoryId: best.repositoryId, priority: best.priority }
}

/** Whether a push's job is waiting: a catch-up turn then ends, so pushes never wait behind one. */
async function writeJobWaiting(): Promise<boolean> {
  const [row] = (await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM jobs WHERE ${claimable} AND priority = ${JOB_PRIORITY.write}) AS waiting`)) as unknown as Array<{
    waiting: boolean
  }>
  return row?.waiting === true
}

async function drainOnce(): Promise<void> {
  try {
    await failCrashedJobs(EXTRACTION_JOB, 'extraction', 'fileId')
    for (;;) {
      const next = await nextRepository()
      if (!next) return
      lastTurn.set(next.repositoryId, ++turn)
      for (let n = 0; n < EXTRACTION_TURN_FILES; n++) {
        if (n > 0 && next.priority !== JOB_PRIORITY.write && (await writeJobWaiting())) break
        const job = await claimJob<{ fileId: string }>(
          EXTRACTION_JOB,
          sql`payload->>'repositoryId' = ${next.repositoryId} AND priority = ${next.priority}`,
        )
        if (!job) break
        const { fileId } = job.payload
        try {
          await extractionWork.processFile(fileId)
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

/** Mutable for tests only: the work for one claimed file (the fairness test swaps it to observe only the scheduler). */
export const extractionWork = { processFile }

/**
 * Rows per INSERT: one statement binds at most 65,534 parameters
 * (postgres.js), and a symbol row has 8, so a generated file with thousands
 * of constants would fail whole (#450 review). Every chunk is in the same
 * transaction, so the file still commits all or nothing.
 */
const INSERT_CHUNK_ROWS = 1_000

function* chunks<T>(rows: readonly T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) yield rows.slice(i, i + INSERT_CHUNK_ROWS)
}

/**
 * Derives one file (#453): everything is computed first, the slow embed
 * included, outside any transaction; then one short transaction locks the
 * row, checks its content is still the one extracted, and replaces the
 * imports, symbols, vectors and versions together. A failure or a crash at
 * any point before the commit leaves the previous rows whole and searchable.
 * A result for content a push replaced meanwhile is dropped: that push
 * enqueued the job of the new content. Vectors the running embedder already
 * made are kept, not embedded again: the file's when its content is the one
 * they were made from, a symbol's when its embed text is unchanged. An
 * `EXTRACTOR_VERSION` bump therefore costs a parse per file, and the
 * embedder only runs for the symbols whose text changed.
 */
async function processFile(fileId: string): Promise<void> {
  const row = (await db.select().from(repositoryFiles).where(eq(repositoryFiles.id, fileId)))[0]
  if (!row) return
  const extractorVersion = EXTRACTOR_VERSION
  const embedderId = EMBEDDER_ID

  // The language comes from the path, not the stored label: a row indexed
  // before its extension was mapped (`.mts`/`.cts` before #451) keeps a stale
  // label, since a sync skips unchanged content. It is written back below.
  const language = detectLanguage(row.path)
  // An unsupported or minified file gets its file vector only, and still loses the imports/symbols an earlier content left.
  const { imports, symbols }: ExtractionResult =
    isSupportedLanguage(language) && !looksMinified(row.content)
      ? await extractStructure(language, row.content, row.path)
      : { imports: [], symbols: [] }

  const importRows: Array<typeof repositoryFileImports.$inferInsert> = []
  if (imports.length > 0) {
    const { pathToId, knownPaths } = await getRepoSiblings(row.repositoryId)
    for (const { target: targetPath, line } of imports) {
      const resolved = resolveImportPath(row.path, targetPath, knownPaths)
      importRows.push({ sourceFileId: fileId, targetPath, resolvedTargetFileId: resolved ? pathToId.get(resolved) : undefined, line })
    }
  }

  const fileLines = symbols.length > 0 ? row.content.split('\n') : []
  const symbolPayloads = symbols.map((s) => {
    const snippetLines = fileLines.slice(s.startLine - 1, s.endLine)
    const snippet = snippetLines.slice(0, 30).join('\n').slice(0, 1500)
    return {
      fileId,
      name: s.name,
      kind: s.kind,
      parent: s.parent ?? null,
      startLine: s.startLine,
      endLine: s.endLine,
      snippet,
      embedText: symbolEmbedText(s.kind, s.name, s.parent ?? null, row.path, s.startLine, snippet),
    }
  })

  // Per-file budget (#496): the file and N of its symbols get a vector, the
  // rest are stored without one, so one file with thousands of declarations
  // neither holds the queue for minutes nor loses its structure. The budget
  // goes to exported symbols, then other module-level ones, then methods,
  // each in file order (#450): a large class early in a file does not take
  // it from the functions after it.
  const budget = config.embedMaxSymbolsPerFile
  const embedOrder = symbols
    .map((s, i) => ({ i, tier: s.kind === 'method' ? 2 : s.exported ? 0 : 1 }))
    .sort((a, b) => a.tier - b.tier)
    .slice(0, budget)
    .map(({ i }) => i)
  let embeddingNote: string | null = null
  if (symbolPayloads.length > budget) {
    embeddingNote = `symbol embeddings capped by ELARA_EMBED_MAX_SYMBOLS_PER_FILE: ${budget} of ${symbolPayloads.length} symbols embedded, the rest are keyword-searchable only`
    console.warn(`[extraction] ${row.path} (repository file ${fileId}): ${embeddingNote}`)
  }

  // The vectors this embedder made for this file: reused where their text is the one to embed now.
  const sameEmbedder = row.embedding !== null && row.embedderId === embedderId
  const reusedFileVector = sameEmbedder && row.extractedHash === row.contentHash ? row.embedding : null
  const previousSymbolVectors = new Map<string, number[]>()
  if (sameEmbedder && embedOrder.length > 0) {
    const previous = await db
      .select({
        name: repositoryFileSymbols.name,
        kind: repositoryFileSymbols.kind,
        parent: repositoryFileSymbols.parent,
        startLine: repositoryFileSymbols.startLine,
        snippet: repositoryFileSymbols.snippet,
        embedding: repositoryFileSymbols.embedding,
      })
      .from(repositoryFileSymbols)
      .where(and(eq(repositoryFileSymbols.fileId, fileId), isNotNull(repositoryFileSymbols.embedding)))
    for (const p of previous) {
      if (p.snippet !== null && p.embedding !== null) {
        previousSymbolVectors.set(symbolEmbedText(p.kind, p.name, p.parent, row.path, p.startLine, p.snippet), p.embedding)
      }
    }
  }
  const toEmbed = [
    ...(reusedFileVector ? [] : [`${row.path}\n${row.content}`]),
    ...embedOrder.map((i) => symbolPayloads[i]!.embedText).filter((text) => !previousSymbolVectors.has(text)),
  ]
  const vectors = toEmbed.length > 0 ? await embedder.embed(toEmbed) : []
  const vectorByText = new Map(toEmbed.map((text, i) => [text, vectors[i]!]))
  const fileEmbedding = reusedFileVector ?? vectorByText.get(`${row.path}\n${row.content}`)!
  const symbolEmbeddings = new Map(
    embedOrder.map((i) => {
      const text = symbolPayloads[i]!.embedText
      return [i, previousSymbolVectors.get(text) ?? vectorByText.get(text) ?? null] as const
    }),
  )
  failpoint('extract.after-embed-before-write')

  const written = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ contentHash: repositoryFiles.contentHash })
      .from(repositoryFiles)
      .where(eq(repositoryFiles.id, fileId))
      .for('update')
    if (current?.contentHash !== row.contentHash) return false
    await tx.delete(repositoryFileImports).where(eq(repositoryFileImports.sourceFileId, fileId))
    // One row per specifier: a file importing one path twice keeps the first line (chunks insert in order).
    for (const chunk of chunks(importRows)) await tx.insert(repositoryFileImports).values(chunk).onConflictDoNothing()
    await tx.delete(repositoryFileSymbols).where(eq(repositoryFileSymbols.fileId, fileId))
    const symbolRows = symbolPayloads.map((s, i) => ({
      fileId: s.fileId,
      name: s.name,
      kind: s.kind,
      parent: s.parent,
      startLine: s.startLine,
      endLine: s.endLine,
      snippet: s.snippet,
      embedding: symbolEmbeddings.get(i) ?? null,
    }))
    for (const chunk of chunks(symbolRows)) await tx.insert(repositoryFileSymbols).values(chunk)
    await tx
      .update(repositoryFiles)
      .set({ language, embedding: fileEmbedding, embeddingNote, extractedHash: row.contentHash, extractorVersion, embedderId })
      .where(eq(repositoryFiles.id, fileId))
    failpoint('extract.before-commit')
    return true
  })
  // An unchanged file vector has the semantic edges it had.
  if (written && !reusedFileVector) await recomputeSemanticEdges('code', fileId, fileEmbedding)
}

/**
 * The text a symbol is embedded from (`EMBED_TEXT_VERSION` in search/embeddings.ts versions it).
 * A method names its class (`method Store.save`, #450); a symbol without a parent has the text
 * it had before, so its vector is reused across the `EXTRACTOR_VERSION` 3 re-extraction.
 */
function symbolEmbedText(kind: string, name: string, parent: string | null, path: string, startLine: number, snippet: string): string {
  return `${kind} ${parent ? `${parent}.` : ''}${name} in ${path}:${startLine}\n${snippet}`
}
