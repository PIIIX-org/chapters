/**
 * Work shared between the files of equal content (#684 part B). Blocks, edges and imports stay one set of rows per
 * repository file (their ids, access and cascade deletes are per repository); only what is a pure function of the
 * content is reused:
 *
 * - `vectorsInAccount`: the vector of an embedded text, found by `embed_key` (model + text) among the code blocks of
 *   the repositories of the same account. The key is computed by the caller from text it holds, and what comes back
 *   is the vector that text embeds to, so no content is read or exposed; the lookup stays inside one account all
 *   the same (a 64-bit key is not a place to let one account's rows stand in for another's), and a file of another
 *   account is embedded again, as before.
 * - `parsed`: the symbols, imports and sites of a content, in this process, keyed by the content's hash, the grammar
 *   its path selects and `EXTRACTOR_VERSION`; a second repository or branch holding the same blob is not parsed again.
 *   Bounded by estimated bytes (ELARA_PARSE_CACHE_MB, a result over a per-entry cap is not kept, #1148) and by
 *   entries, least recently used out.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { textArray } from '../search/block-rows.js'
import { recordCacheLookup } from '../monitoring/metrics.js'
import { EXTRACTOR_VERSION, extractStructure, type ExtractionResult } from './extraction.js'

/** The vectors the account's repositories already hold for `keys`, by key (one deterministic row per key). */
export async function vectorsInAccount(repositoryId: string, keys: readonly string[]): Promise<Map<string, number[]>> {
  if (keys.length === 0) return new Map()
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (b.embed_key) b.embed_key AS "embedKey", b.embedding::text AS embedding
    FROM blocks b
    JOIN repositories r ON r.id = b.container_id
    WHERE b.owner_type = 'code' AND b.embedding IS NOT NULL AND b.embed_key = ANY(${textArray(keys)})
      AND r.owner_id = (SELECT owner_id FROM repositories WHERE id = ${repositoryId})
    ORDER BY b.embed_key, b.id`)) as unknown as Array<{ embedKey: string; embedding: string }>
  recordCacheLookup('blob_vector', true, rows.length)
  recordCacheLookup('blob_vector', false, new Set(keys).size - rows.length)
  return new Map(rows.map((r) => [r.embedKey, JSON.parse(r.embedding) as number[]]))
}

const PARSE_CACHE_ENTRIES = 2_000

/** Default ELARA_PARSE_CACHE_MB (#1148): the byte budget of the parse cache, in MiB. */
export const DEFAULT_PARSE_CACHE_MB = 64

/** `ELARA_PARSE_CACHE_MB` -> a positive whole number of MiB (at most 1 TiB), or null when it is not one. */
export function readParseCacheMb(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_PARSE_CACHE_MB
  if (raw.trim() === '') return null
  const mb = Number(raw)
  return Number.isSafeInteger(mb) && mb > 0 && mb <= 1024 * 1024 ? mb : null
}

if (readParseCacheMb(process.env.ELARA_PARSE_CACHE_MB) === null) {
  console.warn(`ELARA_PARSE_CACHE_MB=${JSON.stringify(process.env.ELARA_PARSE_CACHE_MB)} is not a positive whole number of MiB: using ${DEFAULT_PARSE_CACHE_MB}`)
}

/** The byte budget now, read per call so tests can set the variable after the module loads. */
export function parseCacheBudgetBytes(): number {
  return (readParseCacheMb(process.env.ELARA_PARSE_CACHE_MB) ?? DEFAULT_PARSE_CACHE_MB) * 1024 * 1024
}

/** The largest estimated size of one retained result (#1148): a larger one is returned and not kept. Never above the total budget. */
export const PARSE_CACHE_ENTRY_BYTES = 4 * 1024 * 1024

/*
 * Estimated heap size of an `ExtractionResult`, deliberately a cheap over-estimate (#1148): every string counts
 * 2 bytes per UTF-16 code unit (V8 keeps Latin-1 text at 1), and every item adds a fixed overhead for its object,
 * its array slot and the headers of its strings (V8: a few dozen bytes each), rounded up. Nothing is serialized
 * or walked past the three arrays, so the cost is one pass over the items the parse just built. The budget is a
 * ceiling on this estimate, so the real footprint stays at or under it; exactness is not the point.
 * Strings are charged by length because `detachStrings` gives the retained ones their own storage (see `detach`).
 */
const RESULT_OVERHEAD_BYTES = 64
const SYMBOL_OVERHEAD_BYTES = 128
const IMPORT_OVERHEAD_BYTES = 96
const SITE_OVERHEAD_BYTES = 192

/** The estimated size in bytes of a result held by the parse cache (see the constants above). */
export function estimateExtractionBytes(result: ExtractionResult): number {
  let chars = 0
  for (const s of result.symbols) chars += s.name.length + (s.parent?.length ?? 0)
  for (const i of result.imports) chars += i.target.length
  for (const s of result.sites) chars += s.name.length + (s.qualified?.length ?? 0) + (s.via?.length ?? 0)
  return (
    RESULT_OVERHEAD_BYTES +
    result.symbols.length * SYMBOL_OVERHEAD_BYTES +
    result.imports.length * IMPORT_OVERHEAD_BYTES +
    result.sites.length * SITE_OVERHEAD_BYTES +
    chars * 2
  )
}

/**
 * A string that owns its storage. A string the parser cut out of the file (V8 keeps `slice`/`substring` results of
 * a long text as a view into it) keeps the whole text alive: 2,000 retained one-line names of 1 MiB files would
 * hold 2 GiB while the size estimate (string lengths) says a few hundred KiB. Measured on real extraction (#1148):
 * Python, Rust and Java results kept ~0.75-0.9 MB each for a 0.9 MB source; copied, ~0. The round trip through a
 * UTF-16 buffer always allocates a new string and is lossless for any code unit (UTF-8 is not, for a lone surrogate).
 */
const detach = (s: string): string => Buffer.from(s, 'utf16le').toString('utf16le')

/** Gives every string of a result its own storage (in place, the values do not change) before the cache keeps it. */
function detachStrings(result: ExtractionResult): void {
  for (const s of result.symbols) {
    s.name = detach(s.name)
    if (s.parent !== undefined) s.parent = detach(s.parent)
  }
  for (const i of result.imports) i.target = detach(i.target)
  for (const s of result.sites) {
    s.name = detach(s.name)
    if (s.qualified !== null) s.qualified = detach(s.qualified)
    if (s.via !== null) s.via = detach(s.via)
  }
}

interface ParseCacheEntry {
  result: ExtractionResult
  bytes: number
}
const parseCache = new Map<string, ParseCacheEntry>()
/**
 * Parses run, parses served from the cache, results too large to keep and the estimated bytes held now, since
 * the process started (tests and the lab read them). `bytes` is the sum of the retained entries' estimates.
 */
export const parseCacheStats = { parsed: 0, reused: 0, skippedLarge: 0, bytes: 0 }

/**
 * `extractStructure` for a content known by its `contentHash`, once per process while the entry lasts. Kept while
 * the cache is under its entry bound and its byte budget (`ELARA_PARSE_CACHE_MB`, least recently used out); a
 * result over `PARSE_CACHE_ENTRY_BYTES` (or over the budget) is returned and not kept.
 */
export async function parsed(language: string, content: string, path: string, contentHash: string): Promise<ExtractionResult> {
  // The grammar is chosen from the label and the extension (extraction.ts), so both are part of the key.
  const key = `${EXTRACTOR_VERSION}:${language}:${/\.tsx$/i.test(path) ? 'tsx' : /\.h$/i.test(path) ? 'h' : ''}:${contentHash}`
  const hit = parseCache.get(key)
  recordCacheLookup('blob_parse', hit !== undefined)
  if (hit) {
    parseCache.delete(key)
    parseCache.set(key, hit)
    parseCacheStats.reused++
    return hit.result
  }
  const result = await extractStructure(language, content, path)
  parseCacheStats.parsed++
  const budget = parseCacheBudgetBytes()
  const bytes = estimateExtractionBytes(result)
  if (bytes > Math.min(PARSE_CACHE_ENTRY_BYTES, budget)) {
    parseCacheStats.skippedLarge++
    return result
  }
  detachStrings(result)
  // A concurrent parse of the same key may have stored it while this one ran: replace it, count it once.
  const replaced = parseCache.get(key)
  if (replaced) {
    parseCacheStats.bytes -= replaced.bytes
    parseCache.delete(key)
  }
  parseCache.set(key, { result, bytes })
  parseCacheStats.bytes += bytes
  while (parseCache.size > PARSE_CACHE_ENTRIES || parseCacheStats.bytes > budget) {
    const oldest = parseCache.entries().next().value!
    parseCache.delete(oldest[0])
    parseCacheStats.bytes -= oldest[1].bytes
  }
  return result
}

/** Empties the parse cache (tests). */
export function clearParseCache(): void {
  parseCache.clear()
  parseCacheStats.parsed = 0
  parseCacheStats.reused = 0
  parseCacheStats.skippedLarge = 0
  parseCacheStats.bytes = 0
}
