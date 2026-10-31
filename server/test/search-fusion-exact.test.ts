// #456: exact and identifier matches outrank fuzzy hits in fusion.
// A symbol whose name equals a query term (case-sensitively or by spelling set),
// a file whose path or basename equals a term, or a note whose title or path
// equals the query must never be pushed below a fuzzy-only vector hit.
// A symbol sitting at keyword rank 25 still comes first over fuzzy vector hits.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { findSymbols, searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

let repoId: string
let vaultId: string

afterEach(() => {
  vi.restoreAllMocks()
})

beforeAll(async () => {
  const user = await createActiveUser()
  const [r] = await db
    .insert(repositories)
    .values({
      name: 'fusion-exact-repo',
      ownerId: user.id,
      ingestionMethod: 'agent_push',
    })
    .returning()
  repoId = r!.id
  const [v] = await db
    .insert(vaults)
    .values({ name: 'fusion-exact-vault', ownerId: user.id })
    .returning()
  vaultId = v!.id

  // 1. Fuzzy file with semantic content that will match query vectors
  const fuzzyFile = {
    path: 'src/fuzzy/semantic-heavy.ts',
    content:
      '// semantic concept neural network vector embedding index search\nexport function generalWorker(): void {}\n',
  }

  // Exact symbol file: function alphaHandler
  const exactSymbolFile = {
    path: 'src/handlers/alpha.ts',
    content: 'export function alphaHandler(): string {\n  return "exact"\n}\n',
  }

  // Noise symbol file with higher keyword ranking for query 'alpha_handler'
  // lower(name) LIKE 'alpha_handler%' (CASE 2), whereas alphaHandler is CASE 4
  const noiseSymbolFile = {
    path: 'src/aaa/noise_alpha.ts',
    content: 'export function alpha_handler_noise(): void {}\n',
  }

  // Exact file path/basename file
  const exactFile = {
    path: 'src/utils/config-parser.ts',
    content: '// config-parser.ts\nexport function parseConfig(): void {}\n',
  }

  // Noise file for exact file test: more keyword repetitions, so it wins keyword rank 0
  const fileNoise = {
    path: 'src/aaa/noise_config.ts',
    content:
      '// config-parser.ts config-parser.ts config-parser.ts config-parser.ts\nexport const x = 1\n',
  }

  // 25 noise files with symbols named target_symbol_00..24:
  // For query 'target_symbol', they match CASE 2 (LIKE 'target_symbol%') and rank 0..24.
  // The exact symbol 'targetSymbol' (camelCase) matches CASE 4 (keywords @@ target_symbol)
  // and sits at keyword rank 25.
  const noiseFiles = Array.from({ length: 25 }, (_, i) => {
    const pad = String(i).padStart(2, '0')
    return {
      path: `src/noise/sym_${pad}.ts`,
      content: `export function target_symbol_${pad}(): void {}\n`,
    }
  })

  // Exact symbol with camelCase name 'targetSymbol'
  const exactCamelSymbolFile = {
    path: 'src/zzz/exact-symbol.ts',
    content: 'export function targetSymbol(): void {}\n',
  }
  // Generic basename file 'src/index.ts'
  const indexFile = {
    path: 'src/index.ts',
    content:
      '// application index entry point\nexport const indexVersion = 1\n',
  }

  // One-word names that each equal a single plain term of a multi-word query, and the
  // identifier that matches all three words (#456 review: the one-word hits must not win).
  const queueFile = {
    path: 'src/rq/queue.ts',
    content: 'export function queue(): void {}\n',
  }
  const retryFile = {
    path: 'src/rq/retry.ts',
    content: 'export function retry(): void {}\n',
  }
  const allWordsFile = {
    path: 'src/rq/request-queue-retry.ts',
    content: 'export function requestQueueRetry(): void {}\n',
  }
  const rqFiles = [queueFile, retryFile, allWordsFile]

  await syncRepositoryFiles(
    repoId,
    [
      fuzzyFile,
      exactSymbolFile,
      noiseSymbolFile,
      exactFile,
      fileNoise,
      ...noiseFiles,
      exactCamelSymbolFile,
      indexFile,
      ...rqFiles,
    ],
    [
      fuzzyFile.path,
      exactSymbolFile.path,
      noiseSymbolFile.path,
      exactFile.path,
      fileNoise.path,
      ...noiseFiles.map((f) => f.path),
      exactCamelSymbolFile.path,
      indexFile.path,
      ...rqFiles.map((f) => f.path),
    ],
  )
  await flushExtraction()

  // Notes: a fuzzy note, a noise note that wins keyword rank 0, and an exact note at keyword rank 1
  await createNote(vaultId, {
    path: 'notes/fuzzy-doc',
    frontmatter: { title: 'Fuzzy Document Guide' },
    body: 'Semantic guide about vector search and embeddings.\n',
  })
  await createNote(vaultId, {
    path: 'notes/noise-target',
    frontmatter: { title: 'Noise Target Guide' },
    body: 'notes/exact-target notes/exact-target notes/exact-target notes/exact-target\n',
  })
  await createNote(vaultId, {
    path: 'notes/exact-target',
    frontmatter: { title: 'Exact Target Guide' },
    body: 'Details about exact-target.\n',
  })
  await flushEmbeddings()

  // Set exact hits' block embeddings opposite to fuzzy block so they don't get vector hits,
  // ensuring the comparison isolates vector-only fuzzy hits vs keyword-only exact hits.
  const [fuzzyBlock] = (await db.execute(sql`
    SELECT b.embedding::text FROM blocks b
    JOIN repository_files f ON f.id = b.owner_id
    WHERE f.repository_id = ${repoId} AND f.path = 'src/fuzzy/semantic-heavy.ts' AND b.kind = 'file'
  `)) as unknown as [{ embedding: string }]
  const oppVec = JSON.stringify(
    JSON.parse(fuzzyBlock.embedding).map((v: number) => -v),
  )

  await db.execute(sql`
    UPDATE blocks SET embedding = ${oppVec}::vector
    WHERE owner_id IN (
      SELECT id FROM repository_files WHERE path IN ('src/handlers/alpha.ts', 'src/utils/config-parser.ts')
      UNION
      SELECT id FROM notes WHERE path = 'notes/exact-target'
    )
  `)
}, 180_000)

/** Makes the query embedder answer with the stored vector of the symbol `name`, so that symbol leads the vector leg. */
async function queryLike(name: string): Promise<void> {
  const [row] = (await db.execute(sql`
    SELECT b.embedding::text FROM blocks b
    JOIN repository_files f ON f.id = b.owner_id
    WHERE f.repository_id = ${repoId} AND b.kind = 'symbol' AND b.inner_path = ${name}
  `)) as unknown as [{ embedding: string }]
  const vec = JSON.parse(row.embedding)
  vi.spyOn(embedder, 'embed').mockImplementation(async (texts) =>
    texts.map(() => vec),
  )
}

describe('exact and identifier matches outrank fuzzy ones in fusion (#456)', () => {
  it('exact symbol match outranks a vector-only fuzzy hit', async () => {
    // Vector query returns fuzzy file at rank 0
    const [fuzzyBlock] = (await db.execute(sql`
      SELECT b.embedding::text FROM blocks b
      JOIN repository_files f ON f.id = b.owner_id
      WHERE f.repository_id = ${repoId} AND f.path = 'src/fuzzy/semantic-heavy.ts' AND b.kind = 'file'
    `)) as unknown as [{ embedding: string }]
    const fuzzyVec = JSON.parse(fuzzyBlock.embedding)

    vi.spyOn(embedder, 'embed').mockImplementation(async (texts) =>
      texts.map(() => fuzzyVec),
    )

    // Query 'alpha_handler':
    // On base: fuzzyFile is vector rank 0 (score 1/61 ≈ 0.01639).
    // alpha_handler_noise is keyword rank 0 (score 1/61 ≈ 0.01639).
    // exact symbol alphaHandler is keyword rank 1 (score 1/62 ≈ 0.01613).
    // On base: fuzzyFile or noise beats alphaHandler.
    // With fix: alphaHandler matches by spelling set, gets exact boost, and comes first.
    const res = await searchNotes(
      { vaultIds: [], repositoryIds: [repoId] },
      'alpha_handler',
      10,
      {},
      { includeSymbols: true },
    )
    expect(res.results.length).toBeGreaterThan(0)
    expect(res.results[0]!.resourceType).toBe('symbol')
    expect(res.results[0]!.symbolName).toBe('alphaHandler')
  })

  it('exact file path or basename match outranks a vector-only fuzzy hit', async () => {
    const [fuzzyBlock] = (await db.execute(sql`
      SELECT b.embedding::text FROM blocks b
      JOIN repository_files f ON f.id = b.owner_id
      WHERE f.repository_id = ${repoId} AND f.path = 'src/fuzzy/semantic-heavy.ts' AND b.kind = 'file'
    `)) as unknown as [{ embedding: string }]
    const fuzzyVec = JSON.parse(fuzzyBlock.embedding)

    vi.spyOn(embedder, 'embed').mockImplementation(async (texts) =>
      texts.map(() => fuzzyVec),
    )

    // Query 'config-parser.ts':
    // On base: fuzzyFile is vector rank 0 (score 1/61 ≈ 0.01639).
    // fileNoise has 4 repetitions of config-parser.ts, so it wins keyword rank 0.
    // exactFile sits at keyword rank 1 (score 1/62 ≈ 0.01613).
    // On base: 1/61 > 1/62, so fuzzyFile outranks exactFile!
    // With fix: exactFile matches basename 'config-parser.ts', gets exact boost, and comes first.
    const res = await searchNotes(
      { vaultIds: [], repositoryIds: [repoId] },
      'config-parser.ts',
      10,
    )
    expect(res.results.length).toBeGreaterThan(0)
    expect(res.results[0]!.resourceType).toBe('code')
    expect(res.results[0]!.path).toBe('src/utils/config-parser.ts')
  })

  it('exact note path or title match outranks a vector-only fuzzy hit', async () => {
    const [fuzzyBlock] = (await db.execute(sql`
      SELECT b.embedding::text FROM blocks b
      JOIN notes n ON n.id = b.owner_id
      WHERE n.vault_id = ${vaultId} AND n.path = 'notes/fuzzy-doc'
    `)) as unknown as [{ embedding: string }]
    const fuzzyVec = JSON.parse(fuzzyBlock.embedding)

    vi.spyOn(embedder, 'embed').mockImplementation(async (texts) =>
      texts.map(() => fuzzyVec),
    )

    // Query 'notes/exact-target':
    // On base: notes/fuzzy-doc is vector rank 0 (score 1/61 ≈ 0.01639).
    // notes/noise-target has repeated occurrences, winning keyword rank 0.
    // notes/exact-target is at keyword rank 1 (score 1/62 ≈ 0.01613).
    // On base: 1/61 > 1/62, so fuzzy-doc outranks exact-target!
    // With fix: notes/exact-target matches path exactly, gets exact boost, and comes first.
    const res = await searchNotes(
      { vaultIds: [vaultId], repositoryIds: [] },
      'notes/exact-target',
      10,
    )
    expect(res.results.length).toBeGreaterThan(0)
    expect(res.results[0]!.resourceType).toBe('note')
    expect(res.results[0]!.path).toBe('notes/exact-target')
  })

  it('identifier query whose exact symbol sits at keyword rank 25 still comes first', async () => {
    // Vector leg returns fuzzy symbol at rank 0
    const [fuzzyBlock] = (await db.execute(sql`
      SELECT b.embedding::text FROM blocks b
      JOIN repository_files f ON f.id = b.owner_id
      WHERE f.repository_id = ${repoId} AND f.path = 'src/fuzzy/semantic-heavy.ts' AND b.kind = 'symbol'
    `)) as unknown as [{ embedding: string }]
    const fuzzyVec = JSON.parse(fuzzyBlock.embedding)

    vi.spyOn(embedder, 'embed').mockImplementation(async (texts) =>
      texts.map(() => fuzzyVec),
    )

    // Query 'target_symbol':
    // In keyword leg of findSymbols:
    // target_symbol_00..24 match LIKE 'target_symbol%' (CASE 2) -> ranks 0..24.
    // targetSymbol matches keywords @@ target_symbol (CASE 4) -> rank 25 (score 1/86 ≈ 0.01163).
    // In vector leg: fuzzyWorker gets rank 0 (score 1/61 ≈ 0.01639).
    // On base: fuzzyWorker (rank 0) and target_symbol_00 (rank 0) both have score 1/61 > 1/86.
    // targetSymbol is at rank 25!
    // With fix: targetSymbol matches target_symbol by spelling set, gets exact boost, and comes first!
    const res = await findSymbols([repoId], 'target_symbol', { limit: 10 })
    expect(res.results.length).toBeGreaterThan(0)
    expect(res.results[0]!.name).toBe('targetSymbol')
  })

  it('a one-word name equal to a single term does not outrank the identifier that matches every word', async () => {
    // `queue` and `retry` each equal ONE plain word of the query; requestQueueRetry matches all three.
    const res = await findSymbols([repoId], 'request queue retry', {
      limit: 10,
    })
    const names = res.results.map((r) => r.name)
    expect(names).toContain('requestQueueRetry')
    for (const oneWord of ['queue', 'retry']) {
      if (names.includes(oneWord)) {
        expect(names.indexOf('requestQueueRetry')).toBeLessThan(
          names.indexOf(oneWord),
        )
      }
    }
    for (const r of res.results) expect(r.score).toBeLessThan(0.1)
  })

  it('the same holds through searchNotes: an unrelated one-word file does not jump ahead', async () => {
    const res = await searchNotes(
      { vaultIds: [], repositoryIds: [repoId] },
      'request queue retry',
      10,
      {},
      { includeSymbols: true },
    )
    expect(res.results.length).toBeGreaterThan(0)
    for (const r of res.results) expect(r.score).toBeLessThan(0.1)
    const paths = res.results.map((r) => r.path)
    const best = paths.indexOf('src/rq/request-queue-retry.ts')
    expect(best).toBeGreaterThanOrEqual(0)
    for (const other of ['src/rq/queue.ts', 'src/rq/retry.ts']) {
      if (paths.includes(other)) expect(best).toBeLessThan(paths.indexOf(other))
    }
  })

  it('a single-word query still matches a symbol named exactly that word', async () => {
    const res = await findSymbols([repoId], 'retry', { limit: 5 })
    expect(res.results[0]!.name).toBe('retry')
  })

  it('a generic file stem inside a multi-word question grants no boost', async () => {
    // src/index.ts holds every word of this question, so it is a keyword hit, but `index` is only a plain word here.
    const res = await searchNotes(
      { vaultIds: [], repositoryIds: [repoId] },
      'application index entry point',
      10,
    )
    const indexHit = res.results.find((r) => r.path === 'src/index.ts')
    expect(indexHit).toBeDefined()
    expect(indexHit!.score).toBeLessThan(0.1)
  })

  it('a relaxed row never counts as exact, even when its name is an identifier term of the query (#455 part 2)', async () => {
    // No file holds `zzznomatchword`, so the AND query is empty and `requestQueueRetry` can only arrive as a
    // relaxed row (its name matches the rarest term). The embedder fails so no vector leg returns it as a
    // non-relaxed row; it must rank by its fusion rank and not take EXACT_BOOST.
    vi.spyOn(embedder, 'embed').mockRejectedValue(new Error('embedder down'))
    const res = await findSymbols(
      [repoId],
      'requestQueueRetry zzznomatchword',
      { limit: 10 },
    )
    expect(res.retrieval_mode).toBe('keyword_only')
    const hit = res.results.find((r) => r.name === 'requestQueueRetry')
    expect(hit).toBeDefined()
    expect(hit!.score).toBeLessThan(0.1)
  })

  it('an identifier mentioned in passing inside a long question grants no boost', async () => {
    // `alphaHandler` is identifier-shaped and the vector leg returns it first, but the question is about the
    // pipeline (benchmark: `SessionDB` or `SKILL.md` named in passing buried the answer under the symbol of
    // that name).
    await queryLike('alphaHandler')
    const res = await findSymbols(
      [repoId],
      'how does the alphaHandler fit into the request pipeline',
      { limit: 10 },
    )
    const hit = res.results.find((r) => r.name === 'alphaHandler')
    expect(hit).toBeDefined()
    expect(hit!.score).toBeLessThan(0.1)
  })

  it('an identifier in backticks inside a long question counts: the asker singled it out', async () => {
    await queryLike('alphaHandler')
    const res = await findSymbols(
      [repoId],
      'how does the `alphaHandler` fit into the request pipeline',
      { limit: 10 },
    )
    const hit = res.results.find((r) => r.name === 'alphaHandler')
    expect(hit).toBeDefined()
    expect(hit!.score).toBeGreaterThan(1)
  })
})
