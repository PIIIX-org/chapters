import { eq, sql, type SQL } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { repositoryFileImports, repositoryFiles } from '../db/schema.js'
import { failpoint } from '../failpoints.js'
import { chunks, keywordVector, replaceBlockSet, vectorsByEmbedKey } from '../search/block-rows.js'
import { CHUNK_VERSION, embedKey } from '../search/embed-key.js'
import { EMBEDDER_ID, embedder } from '../search/embeddings.js'
import { fileKeywords, symbolKeywords } from '../search/identifiers.js'
import { recomputeSemanticEdges } from '../search/semantic-edges.js'
import { codeBlocks } from './code-blocks.js'
import { EXTRACTOR_VERSION, extractStructure, isSupportedLanguage, type ExtractionResult } from './extraction.js'
import {
  RESOLUTION_MANIFEST_PATTERN,
  buildResolutionContext,
  resolveImportPath,
  type ResolutionContext,
} from './import-resolution.js'
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
 * `extractionJobKey` below (#453, #452).
 * Fair across repositories (#497): each turn
 * claims at most `EXTRACTION_TURN_FILES` jobs of one repository, then the
 * repository with claimable jobs that was served least recently goes next
 * (ties: the oldest job). A large repository's backlog therefore delays
 * another repository's files by at most one turn, and a repository's own
 * files keep their enqueue order.
 */
const EXTRACTION_TURN_FILES = 10
export const EXTRACTION_JOB = 'extract'

/** The versions part of an extraction job key: `<EXTRACTOR_VERSION>:<EMBEDDER_ID>+chunk<CHUNK_VERSION>`. */
function versionsKey(): string {
  return `${EXTRACTOR_VERSION}:${EMBEDDER_ID}+chunk${CHUNK_VERSION}`
}

/** The key of the job that derives a file's content `contentHash` with the running extractor, embedder and chunker (#453, #452). */
export function extractionJobKey(fileId: string, contentHash: string): string {
  return `${EXTRACTION_JOB}:${fileId}:${contentHash}:${versionsKey()}`
}

/** `extractionJobKey` in SQL, from a file row's `id` and `content_hash`. */
export function extractionJobKeySql(id: SQL, contentHash: SQL): SQL {
  return sql`${EXTRACTION_JOB} || ':' || ${id} || ':' || ${contentHash} || ':' || ${versionsKey()}`
}

/**
 * True when the file row `f` has blocks derived from its current content
 * (`owner_version` = its `content_hash`; the legacy blocks migration 0035
 * carried over have none). Every extraction writes at least one block.
 */
export function hasCurrentBlocksSql(): SQL {
  return sql`EXISTS (SELECT 1 FROM blocks b WHERE b.owner_type = 'code' AND b.owner_id = f.id AND b.owner_version = f.content_hash)`
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

interface RepoSiblings {
  pathToId: Map<string, string>
  knownPaths: Set<string>
  /** What the repository's manifests say about module names (#466). */
  context: ResolutionContext
}

/** A repository's file paths and ids, and the content of its manifests for the resolution context, in one query. */
async function loadRepoSiblings(repositoryId: string): Promise<RepoSiblings> {
  const files = await db
    .select({
      id: repositoryFiles.id,
      path: repositoryFiles.path,
      manifest: sql<string | null>`CASE WHEN ${repositoryFiles.path} ~ ${RESOLUTION_MANIFEST_PATTERN} THEN ${repositoryFiles.content} END`,
    })
    .from(repositoryFiles)
    .where(eq(repositoryFiles.repositoryId, repositoryId))
  return {
    pathToId: new Map(files.map((f) => [f.path, f.id])),
    knownPaths: new Set(files.map((f) => f.path)),
    context: buildResolutionContext(files.flatMap((f) => (f.manifest === null ? [] : [{ path: f.path, content: f.manifest }]))),
  }
}

// ponytail: repo path cache to eliminate N*N sibling queries during batch extraction (DB-09).
const repoSiblingsCache = new Map<string, RepoSiblings>()

async function getRepoSiblings(repositoryId: string): Promise<RepoSiblings> {
  let cached = repoSiblingsCache.get(repositoryId)
  if (!cached) {
    cached = await loadRepoSiblings(repositoryId)
    repoSiblingsCache.set(repositoryId, cached)
  }
  return cached
}

/** Import rows `reresolveRepositoryImports` reads and updates per statement. */
const RERESOLVE_BATCH = 1000

/**
 * Resolves a repository's stored import rows again from their raw
 * `target_path` (no re-parse), with its current files and manifests, in
 * keyset pages of `RERESOLVE_BATCH` rows and one UPDATE per page for the
 * rows whose target changed. `unresolved`: the rows without a target.
 * `nonRelative`: every row whose specifier does not start with `.`, the
 * ones manifests decide (#466): a renamed package loses its old name's
 * edges as the new name gains them. Returns the rows that gained a target.
 */
async function reresolveRepositoryImports(repositoryId: string, rows: 'unresolved' | 'nonRelative'): Promise<number> {
  const { pathToId, knownPaths, context } = await loadRepoSiblings(repositoryId)
  const scope = rows === 'unresolved' ? sql`i.resolved_target_file_id IS NULL` : sql`i.target_path NOT LIKE '.%'`
  let after: { sourceFileId: string; targetPath: string } | null = null
  let gained = 0
  for (;;) {
    const page = (await db.execute(sql`
      SELECT i.source_file_id AS "sourceFileId", i.target_path AS "targetPath",
        i.resolved_target_file_id AS "resolvedId", f.path AS "sourcePath"
      FROM repository_file_imports i JOIN repository_files f ON f.id = i.source_file_id
      WHERE f.repository_id = ${repositoryId} AND ${scope}
        ${after ? sql`AND (i.source_file_id, i.target_path) > (${after.sourceFileId}::uuid, ${after.targetPath})` : sql``}
      ORDER BY i.source_file_id, i.target_path
      LIMIT ${RERESOLVE_BATCH}`)) as unknown as Array<{
      sourceFileId: string
      targetPath: string
      resolvedId: string | null
      sourcePath: string
    }>
    const changed = page.flatMap((r) => {
      const resolved = resolveImportPath(r.sourcePath, r.targetPath, knownPaths, context)
      const target = (resolved && pathToId.get(resolved)) ?? null
      return target === r.resolvedId ? [] : [{ source: r.sourceFileId, path: r.targetPath, target }]
    })
    if (changed.length > 0) {
      await db.execute(sql`
        UPDATE repository_file_imports i SET resolved_target_file_id = u.target
        FROM jsonb_to_recordset(${JSON.stringify(changed)}::jsonb) AS u(source uuid, path text, target uuid)
        WHERE i.source_file_id = u.source AND i.target_path = u.path`)
      gained += changed.filter((c) => c.target !== null).length
    }
    if (page.length < RERESOLVE_BATCH) break
    after = page.at(-1)!
  }
  return gained
}

/** Repositories whose manifests a sync changed; the extraction worker re-resolves their imports (#466). */
const manifestsChanged = new Set<string>()

/**
 * A sync created, changed or deleted a package.json, pnpm-workspace.yaml or
 * tsconfig/jsconfig of this repository: before its next turn the extraction
 * worker re-resolves the repository's non-relative imports with the new
 * manifests and drops its cached ones, so no file it extracts afterwards
 * resolves with the old ones. In memory: after a crash the boot backfill
 * resolves what gained a target; a row that lost one keeps it until its
 * file is extracted again.
 */
export function scheduleImportReresolution(repositoryId: string): void {
  manifestsChanged.add(repositoryId)
  extraction.kick()
}

async function reresolveChangedManifests(): Promise<void> {
  for (const repositoryId of manifestsChanged) {
    manifestsChanged.delete(repositoryId)
    repoSiblingsCache.delete(repositoryId)
    try {
      await reresolveRepositoryImports(repositoryId, 'nonRelative')
    } catch (err) {
      manifestsChanged.add(repositoryId)
      throw err
    }
  }
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
 * `target_path` (no re-parse), per repository with its manifests
 * (`reresolveRepositoryImports`). Extraction only re-runs when content
 * changes, so rows written by an older resolver stay unresolved until
 * this runs. Idempotent; called once at startup. Returns rows resolved.
 */
export async function backfillUnresolvedImports(): Promise<number> {
  const repos = (await db.execute(sql`
    SELECT DISTINCT f.repository_id AS "repositoryId"
    FROM repository_file_imports i JOIN repository_files f ON f.id = i.source_file_id
    WHERE i.resolved_target_file_id IS NULL`)) as unknown as Array<{ repositoryId: string }>
  let resolvedCount = 0
  for (const { repositoryId } of repos) resolvedCount += await reresolveRepositoryImports(repositoryId, 'unresolved')
  return resolvedCount
}

/**
 * Boot catch-up: enqueue every file whose derived rows are not those of its
 * current content by the running code (#453, #452): no blocks of this
 * content (`hasCurrentBlocksSql`, e.g. only the legacy blocks migration 0035
 * carried over), extracted from
 * another content hash (`extracted_hash`, e.g. a push the process died in
 * before it enqueued), or by another `EXTRACTOR_VERSION`, `EMBEDDER_ID` or `CHUNK_VERSION` —
 * unless a job for that already exists — and every file whose job for the
 * current key failed with an error (an updated file keeps its previous rows).
 * Then wake the worker, which also reclaims jobs whose lease a dead process
 * left. Idempotent: a pending job is left as it is. A job that failed with an
 * error runs again (the outage that failed it may be over, as a restart
 * repaired it before #494); one whose runs ended with the process
 * (`LeaseExpired`) does not, so a crash loop is not restarted at every boot.
 * A version bump changes the key, so such a file gets one new job (3
 * attempts) per new extractor, embedder or chunker. Keyset pages of
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
          ((NOT ${hasCurrentBlocksSql()} OR f.extracted_hash IS DISTINCT FROM f.content_hash
            OR f.extractor_version <> ${EXTRACTOR_VERSION} OR f.embedder_id IS DISTINCT FROM ${EMBEDDER_ID}
            OR f.chunk_version <> ${CHUNK_VERSION})
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

/** What `extractionState` reports for a set of repositories. */
export interface ExtractionState {
  /** Files of the repositories. */
  files: number
  /** Files whose extraction for their current content is still to come: a pending (queued or running) job, or no job and no block of its current content (the boot scan adds its job). */
  pending: number
  /** Files whose job for their current content gave up (`extractionFailures` lists them). */
  failed: number
  /** Repositories with no file yet whose first sync is running or has not happened (a git clone in progress, an agent_push repository before its first push); a repository being synced again counts too. */
  syncing: number
  /** Repositories with no file whose sync failed. */
  syncFailed: number
}

/**
 * Extraction and sync state of these repositories, reported by search next to
 * its results (#442): an answer with no hit says `index_building` while files
 * or whole repositories are still to come, `unavailable` when nothing in scope
 * could be indexed.
 */
export async function extractionState(repositoryIds: string[]): Promise<ExtractionState> {
  if (repositoryIds.length === 0) return { files: 0, pending: 0, failed: 0, syncing: 0, syncFailed: 0 }
  const [row] = (await db.execute(sql`
    WITH per_repo AS (
      SELECT f.repository_id, count(*) AS files,
        count(*) FILTER (WHERE j.id IS NOT NULL AND j.done_at IS NULL OR j.id IS NULL AND NOT ${hasCurrentBlocksSql()}) AS pending,
        count(*) FILTER (WHERE j.done_at IS NOT NULL AND j.last_error IS NOT NULL) AS failed
      FROM repository_files f
      LEFT JOIN jobs j ON j.idempotency_key = ${extractionJobKeySql(sql`f.id`, sql`f.content_hash`)}
      WHERE f.repository_id = ANY(${`{${repositoryIds.join(',')}}`}::uuid[])
      GROUP BY f.repository_id
    )
    SELECT coalesce(sum(p.files), 0)::int AS files, coalesce(sum(p.pending), 0)::int AS pending, coalesce(sum(p.failed), 0)::int AS failed,
      (count(*) FILTER (WHERE r.sync_status = 'syncing' OR r.sync_status <> 'error' AND r.last_synced_at IS NULL AND p.files IS NULL))::int AS syncing,
      (count(*) FILTER (WHERE r.sync_status = 'error' AND p.files IS NULL))::int AS "syncFailed"
    FROM repositories r
    LEFT JOIN per_repo p ON p.repository_id = r.id
    WHERE r.id = ANY(${`{${repositoryIds.join(',')}}`}::uuid[])`)) as unknown as [ExtractionState]
  return row ?? { files: 0, pending: 0, failed: 0, syncing: 0, syncFailed: 0 }
}

/** Files of a repository whose extraction for their current content is still to come (`extractionState`); 0 = extraction finished. */
export async function countPendingExtractions(repositoryId: string): Promise<number> {
  return (await extractionState([repositoryId])).pending
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
      // Between turns, so no file is mid-extraction with the manifests a sync replaced.
      await reresolveChangedManifests()
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
 * Derives one file (#453, #413, #460): everything is computed first, the
 * slow embed included, outside any transaction; then one short transaction
 * locks the row, checks its content is still the one extracted, and replaces
 * the imports, the file's whole block set and the versions together. A
 * failure or a crash at any point before the commit leaves the previous rows
 * whole and searchable. A result for content a push replaced meanwhile (an
 * older `owner_version`) is dropped: that push enqueued the job of the new
 * content. Blocks are upserted by `block_id`, so a block that survives keeps
 * its row; one whose `embedKey` (model + embedded text) a block of the file
 * already has keeps that vector instead of being embedded again, so an edit
 * elsewhere or a version bump re-embeds only changed texts.
 */
async function processFile(fileId: string): Promise<void> {
  const row = (await db.select().from(repositoryFiles).where(eq(repositoryFiles.id, fileId)))[0]
  if (!row) return
  const extractorVersion = EXTRACTOR_VERSION
  const embedderId = EMBEDDER_ID
  const chunkVersion = CHUNK_VERSION

  // The language comes from the path, not the stored label: a row indexed
  // before its extension was mapped (`.mts`/`.cts` before #451) keeps a stale
  // label, since a sync skips unchanged content. It is written back below.
  const language = detectLanguage(row.path)
  // An unsupported or minified file gets its file block only, and still loses the imports/symbols an earlier content left.
  const minified = looksMinified(row.content)
  const { imports, symbols }: ExtractionResult =
    isSupportedLanguage(language) && !minified ? await extractStructure(language, row.content, row.path) : { imports: [], symbols: [] }
  // The keyword channel's identifier lexemes (#455): a minified file's mangled names are left out, its path kept.
  const keywords = keywordVector(fileKeywords(row.path, minified ? null : row.content))

  const importRows: Array<typeof repositoryFileImports.$inferInsert> = []
  if (imports.length > 0) {
    const { pathToId, knownPaths, context } = await getRepoSiblings(row.repositoryId)
    for (const { target: targetPath, line } of imports) {
      const resolved = resolveImportPath(row.path, targetPath, knownPaths, context)
      importRows.push({ sourceFileId: fileId, targetPath, resolvedTargetFileId: resolved ? pathToId.get(resolved) : undefined, line })
    }
  }

  const fileBlocks = codeBlocks(fileId, row.path, row.content, symbols)

  // Per-file budget (#496): the file-level block and N of its symbols get a
  // vector, the rest are stored without one (null embed_key), so one file
  // with thousands of declarations neither holds the queue for minutes nor
  // loses its structure. The budget goes to exported symbols, then other
  // module-level ones, then methods, each in file order (#450): a large class
  // early in a file does not take it from the functions after it. A class
  // skeleton is embedded when its class is.
  const budget = config.embedMaxSymbolsPerFile
  const symbolOrder = fileBlocks
    .flatMap((b, i) => (b.budgetTier === null ? [] : [{ i, tier: b.budgetTier }]))
    .sort((a, b) => a.tier - b.tier)
  const budgeted = new Set(symbolOrder.slice(0, budget).map(({ i }) => i))
  let embeddingNote: string | null = null
  if (symbolOrder.length > budget) {
    embeddingNote = `symbol embeddings capped by ELARA_EMBED_MAX_SYMBOLS_PER_FILE: ${budget} of ${symbolOrder.length} symbols embedded, the rest are keyword-searchable only`
    console.warn(`[extraction] ${row.path} (repository file ${fileId}): ${embeddingNote}`)
  }
  // The file-level block first, then the symbols in budget order, then the class skeletons.
  const embedOrder = [
    ...fileBlocks.flatMap((b, i) => (b.budgetTier === null && b.outlineOf === undefined ? [i] : [])),
    ...symbolOrder.filter(({ i }) => budgeted.has(i)).map(({ i }) => i),
    ...fileBlocks.flatMap((b, i) => (b.outlineOf !== undefined && budgeted.has(b.outlineOf) ? [i] : [])),
  ]

  const kept = await vectorsByEmbedKey('code', fileId)
  const keys = new Map(embedOrder.map((i) => [i, embedKey(fileBlocks[i]!.embedText)]))
  const vectors = new Map<number, number[]>()
  const toEmbed: number[] = []
  for (const i of embedOrder) {
    const reused = kept.get(keys.get(i)!)
    if (reused) vectors.set(i, reused)
    else toEmbed.push(i)
  }
  if (toEmbed.length > 0) {
    const embedded = await embedder.embed(toEmbed.map((i) => fileBlocks[i]!.embedText))
    toEmbed.forEach((i, k) => vectors.set(i, embedded[k]!))
  }
  failpoint('extract.after-embed-before-write')

  const blockRows = fileBlocks.map((b, i) => ({
    ownerType: 'code' as const,
    ownerId: fileId,
    containerId: row.repositoryId,
    blockId: b.blockId,
    kind: b.kind,
    innerPath: b.innerPath,
    symbolKind: b.symbolKind,
    symbolParent: b.symbolParent,
    snippet: b.snippet,
    keywords: b.kind === 'symbol' ? symbolKeywords(row.path, b.innerPath) : null,
    startLine: b.startLine,
    endLine: b.endLine,
    contentHash: b.contentHash,
    ownerVersion: row.contentHash,
    embedKey: keys.get(i) ?? null,
    embedding: vectors.get(i) ?? null,
  }))
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
    // The block set is replaced whole: blocks this content no longer has go, the others are written over in place.
    await replaceBlockSet(tx, 'code', fileId, blockRows)
    // The code keyword leg's document (#455, migration 0044): the row's `fts` (of this content, checked above) plus
    // the identifier lexemes. Raw SQL: `keyword_fts`, like `fts`, is kept out of the Drizzle model, so a `select()`
    // of files never reads it.
    await tx.execute(sql`
      UPDATE repository_files SET language = ${language}, embedding_note = ${embeddingNote}, extracted_hash = ${row.contentHash},
        extractor_version = ${extractorVersion}, embedder_id = ${embedderId}, chunk_version = ${chunkVersion},
        keyword_fts = ${keywords ? sql`fts || ${keywords}` : null}
      WHERE id = ${fileId}`)
    failpoint('extract.before-commit')
    return true
  })
  // The file's semantic neighbours are those of its file-level block (the first, always embedded);
  // a file-level vector kept as it was has the edges it had.
  if (written && toEmbed.includes(0)) await recomputeSemanticEdges('code', fileId, [vectors.get(0)!])
}
