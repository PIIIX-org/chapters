import type { SearchFilters } from './search.js'

/** The query string of every search route: vault, everywhere (search/routes.ts) and repository (repositories/routes.ts). */
export const searchQuerySchema = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', minLength: 1, maxLength: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    types: { type: 'string' },
    tags: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    languages: { type: 'string' },
    kinds: { type: 'string' },
    path: { type: 'string', minLength: 1, maxLength: 500 },
    symbols: { type: 'boolean' },
  },
} as const

export interface SearchQuery {
  q: string
  limit?: number
  types?: string
  tags?: string
  since?: string
  until?: string
  languages?: string
  kinds?: string
  path?: string
  symbols?: boolean
}

const list = (value: string | undefined) => (value ? value.split(',').filter(Boolean) : undefined)

/** Same wire format as graph/filters.ts `parseGraphFilters`: comma-separated lists. */
export function parseSearchFilters(q: SearchQuery): SearchFilters {
  return {
    types: list(q.types),
    tags: list(q.tags),
    since: q.since,
    until: q.until,
    languages: list(q.languages),
    kinds: list(q.kinds),
    path: q.path,
  }
}
