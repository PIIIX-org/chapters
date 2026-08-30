import type { GraphFilters } from './assemble.js'

/** The raw graph querystring, exactly as every graph route receives it. */
export interface GraphQuery {
  types?: string
  tags?: string
  since?: string
  until?: string
  aggregate?: string
  community?: string
}

/**
 * One querystring contract for every graph endpoint — vault, repository,
 * merged. Before #101 the vault route validated `aggregate` and the
 * repository route had no schema at all, so `?aggregate=bogus` was a 400
 * on one and a 200 with the full graph on the other. `community` is a
 * Louvain community number: a non-negative integer, so `-1`, blanks and
 * text are rejected here instead of silently matching nothing.
 */
export const graphQuerySchema = {
  type: 'object',
  properties: {
    types: { type: 'string' },
    tags: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    aggregate: { type: 'string', enum: ['community'] },
    community: { type: 'string', pattern: '^[0-9]+$' },
  },
} as const

export function parseGraphFilters(q: GraphQuery): GraphFilters {
  return {
    types: q.types ? q.types.split(',').filter(Boolean) : undefined,
    tags: q.tags ? q.tags.split(',').filter(Boolean) : undefined,
    since: q.since,
    until: q.until,
    aggregate: q.aggregate === 'community' ? 'community' : undefined,
    community: q.community !== undefined ? Number(q.community) : undefined,
  }
}
