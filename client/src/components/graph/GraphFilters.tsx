// Filter panel for the graph: type, tags, date range. Mirrors the server's
// `parseFilters` (server/src/graph/routes.ts) exactly — `types`/`tags` as
// comma-joined multi-select, `since`/`until` as the raw yyyy-mm-dd string a
// native <input type="date"> yields.
//
// State lives in the URL (`?types=`, `?tags=`, `?since=`, `?until=`),
// alongside `vault` and `color` — same technique as ColorModeToggle — so
// GraphCanvas's and GraphOutline's `useGraph` calls pick it up through their
// query key, the view is shareable, and back/forward work for free (browser
// history, not component state).
import { useSearchParams } from 'react-router'
import type { GraphFilters as GraphFiltersValue } from '../../api/graph.js'
import { cn } from '../../lib/utils.js'

const FILTER_KEYS = ['types', 'tags', 'since', 'until'] as const

/** The one place a URLSearchParams is turned into the shape useGraph wants.
 * `prefix` namespaces the four keys — pass the same prefix a caller uses when
 * rendering <GraphFilters paramPrefix> so two filter panels mounted at once
 * (the graph's own, and ⌘K's) never read or write each other's params. */
export function graphFiltersFromSearchParams(params: URLSearchParams, prefix = ''): GraphFiltersValue {
  const types = params.get(`${prefix}types`)
  const tags = params.get(`${prefix}tags`)
  const since = params.get(`${prefix}since`)
  const until = params.get(`${prefix}until`)
  return {
    types: types ? types.split(',').filter(Boolean) : undefined,
    tags: tags ? tags.split(',').filter(Boolean) : undefined,
    since: since ?? undefined,
    until: until ?? undefined,
  }
}

/** A node shape both GraphNode (member view) and any future source can satisfy. */
export interface FilterableNode {
  type: string | null
  tags: string[]
}

export interface GraphFiltersProps {
  /**
   * Options come from the currently loaded graph, never a hardcoded list —
   * an aggregated CommunityGraph carries no per-node type/tags, so this is
   * empty until a community view with real nodes is loaded.
   */
  nodes: FilterableNode[]
  /** See graphFiltersFromSearchParams — defaults to unprefixed for the graph's own panel. */
  paramPrefix?: string
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function toggled(list: string[] | undefined, value: string): string[] {
  const set = new Set(list ?? [])
  if (set.has(value)) set.delete(value)
  else set.add(value)
  return [...set]
}

export function GraphFilters({ nodes, paramPrefix = '' }: GraphFiltersProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = graphFiltersFromSearchParams(searchParams, paramPrefix)

  // Union with the currently-selected values, not node-derived values alone:
  // narrowing the result/node set (a tag filter narrows exactly what tags
  // show up) must never delete the checkbox for a value that's still active
  // — that would leave a filter applied with no control left to switch it
  // off.
  const availableTypes = uniqueSorted([
    ...nodes.map((n) => n.type).filter((t): t is string => Boolean(t)),
    ...(filters.types ?? []),
  ])
  const availableTags = uniqueSorted([...nodes.flatMap((n) => n.tags), ...(filters.tags ?? [])])

  const activeCount =
    (filters.types?.length ?? 0) + (filters.tags?.length ?? 0) + (filters.since ? 1 : 0) + (filters.until ? 1 : 0)

  function setParam(key: (typeof FILTER_KEYS)[number], value: string | undefined) {
    const fullKey = `${paramPrefix}${key}`
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(fullKey, value)
      else next.delete(fullKey)
      return next
    })
  }

  function toggleType(type: string) {
    const next = toggled(filters.types, type)
    setParam('types', next.length ? next.join(',') : undefined)
  }

  function toggleTag(tag: string) {
    const next = toggled(filters.tags, tag)
    setParam('tags', next.length ? next.join(',') : undefined)
  }

  function clearFilters() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const key of FILTER_KEYS) next.delete(`${paramPrefix}${key}`)
      return next
    })
  }

  return (
    <div className="flex w-64 flex-col gap-3 rounded-md border border-border bg-card p-3 text-sm shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-sm text-foreground">Filters</h2>
        <span className="text-xs text-muted-foreground">
          {activeCount === 0 ? 'No filters active' : `${activeCount} filter${activeCount === 1 ? '' : 's'} active`}
        </span>
      </div>

      {availableTypes.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Type</legend>
          {availableTypes.map((type) => (
            <label
              key={type}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 hover:bg-muted',
                filters.types?.includes(type) && 'bg-muted text-foreground',
              )}
            >
              <input type="checkbox" checked={filters.types?.includes(type) ?? false} onChange={() => toggleType(type)} />
              {type}
            </label>
          ))}
        </fieldset>
      )}

      {availableTags.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Tags</legend>
          {availableTags.map((tag) => (
            <label
              key={tag}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 hover:bg-muted',
                filters.tags?.includes(tag) && 'bg-muted text-foreground',
              )}
            >
              <input type="checkbox" checked={filters.tags?.includes(tag) ?? false} onChange={() => toggleTag(tag)} />
              {tag}
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Date range</legend>
        <label className="flex items-center justify-between gap-2">
          <span>Since</span>
          <input
            type="date"
            value={filters.since ?? ''}
            onChange={(e) => setParam('since', e.currentTarget.value || undefined)}
            className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs"
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Until</span>
          <input
            type="date"
            value={filters.until ?? ''}
            onChange={(e) => setParam('until', e.currentTarget.value || undefined)}
            className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs"
          />
        </label>
      </fieldset>

      {activeCount > 0 && (
        <button
          type="button"
          onClick={clearFilters}
          className="self-start rounded px-1.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}
