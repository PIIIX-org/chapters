import { randomUUID } from 'node:crypto'
import { recordCacheLookup } from '../monitoring/metrics.js'
import { repositoryIndexedVersion, type IndexedVersion } from '../repositories/store.js'
import { searchNotes, type SearchResourceSet, type SearchResponse, type SearchResult } from '../search/search.js'
import { cacheKey, readEpochs, type CacheCaller } from './key.js'

// A process-local namespace also versions client-held revisions across builds/restarts.
let generation = randomUUID()
const CAPACITY = 128
const entries = new Map<string, { answer: SearchResponse<SearchResult>; version: IndexedVersion }>()

export interface SearchArguments {
  query: string
  symbols?: boolean
  limit?: number
  everywhere?: boolean
  if_rev?: string
  [key: string]: unknown
}

/** Called only after live token, capability, pin and resource-access checks. Never stores rendered pages. */
export async function cachedSearch(resources: SearchResourceSet, args: SearchArguments, caller: CacheCaller) {
  const keyArgs = { ...args }
  delete keyArgs.if_rev
  const identify = async () => cacheKey('search', { ...keyArgs, generation }, resources, await readEpochs(resources), caller)
  const before = await identify()
  const hit = before === null ? undefined : entries.get(before)
  if (hit && await identify() === before) {
    entries.delete(before!)
    entries.set(before!, hit)
    recordCacheLookup('search', true)
    return { ...hit, rev: before }
  }
  recordCacheLookup('search', false)
  const answer = await searchNotes(resources, args.query, (args.limit ?? 20) + 1, {}, { includeSymbols: args.symbols ?? true, accountId: caller.userId })
  const version = resources.repositoryIds.length === 1 ? await repositoryIndexedVersion(resources.repositoryIds[0]!) : {}
  // A write during computation must not stamp a mixed/new snapshot with its old epoch.
  // Degraded answers must be retried: service recovery need not move a content epoch.
  if (before === null || answer.degraded !== false || await identify() !== before) return { answer, version, rev: null }
  entries.set(before, { answer, version })
  if (entries.size > CAPACITY) entries.delete(entries.keys().next().value!)
  return { answer, version, rev: before }
}

/** Explicit purge evicts retained plaintext and invalidates in-flight fills; also used by isolated tests. */
export function clearSearchCache(): void {
  generation = randomUUID()
  entries.clear()
}
