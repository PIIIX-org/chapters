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
 *   Bounded by entries, least recently used out.
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
const parseCache = new Map<string, ExtractionResult>()
/** Parses run and parses served from the cache since the process started (tests and the lab read them). */
export const parseCacheStats = { parsed: 0, reused: 0 }

/** `extractStructure` for a content known by its `contentHash`, once per process while the entry lasts. */
export async function parsed(language: string, content: string, path: string, contentHash: string): Promise<ExtractionResult> {
  // The grammar is chosen from the label and the extension (extraction.ts), so both are part of the key.
  const key = `${EXTRACTOR_VERSION}:${language}:${/\.tsx$/i.test(path) ? 'tsx' : /\.h$/i.test(path) ? 'h' : ''}:${contentHash}`
  const hit = parseCache.get(key)
  recordCacheLookup('blob_parse', hit !== undefined)
  if (hit) {
    parseCache.delete(key)
    parseCache.set(key, hit)
    parseCacheStats.reused++
    return hit
  }
  const result = await extractStructure(language, content, path)
  parseCacheStats.parsed++
  parseCache.set(key, result)
  if (parseCache.size > PARSE_CACHE_ENTRIES) parseCache.delete(parseCache.keys().next().value!)
  return result
}

/** Empties the parse cache (tests). */
export function clearParseCache(): void {
  parseCache.clear()
  parseCacheStats.parsed = 0
  parseCacheStats.reused = 0
}
