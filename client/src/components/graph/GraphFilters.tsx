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
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  deleteGraphPerspective,
  fetchGraphPerspectives,
  saveGraphPerspective,
  type GraphFilters as GraphFiltersValue,
  type GraphPerspective,
} from '../../api/graph.js'
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
  /** Explicit vault ID constraint (falls back to ?vault search param). */
  vaultId?: string | null
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

export function GraphFilters({ nodes = [], paramPrefix = '', vaultId: propVaultId }: GraphFiltersProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = graphFiltersFromSearchParams(searchParams, paramPrefix)

  const effectiveVaultId = propVaultId !== undefined ? propVaultId : searchParams.get('vault')

  const [perspectives, setPerspectives] = useState<GraphPerspective[]>([])
  const [selectedPerspectiveId, setSelectedPerspectiveId] = useState<string>('all')
  const [prevVaultId, setPrevVaultId] = useState(effectiveVaultId)
  if (prevVaultId !== effectiveVaultId) {
    setPrevVaultId(effectiveVaultId)
    setSelectedPerspectiveId('all')
  }
  const [isSaving, setIsSaving] = useState(false)
  const [newPerspectiveName, setNewPerspectiveName] = useState('')
  const [newPerspectiveShared, setNewPerspectiveShared] = useState(true)

  useEffect(() => {
    if (paramPrefix !== '') return
    let cancelled = false
    fetchGraphPerspectives(effectiveVaultId)
      .then((data) => {
        if (!cancelled) setPerspectives(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [effectiveVaultId, paramPrefix])

  function handleSelectPerspective(id: string) {
    setSelectedPerspectiveId(id)
    if (id === 'all') {
      clearFilters()
      return
    }
    if (id === 'preset:arch') {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set(`${paramPrefix}types`, 'adr,spec,rfc')
        next.set(`${paramPrefix}tags`, 'architecture')
        next.delete(`${paramPrefix}since`)
        next.delete(`${paramPrefix}until`)
        return next
      })
      return
    }
    if (id === 'preset:security') {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete(`${paramPrefix}types`)
        next.set(`${paramPrefix}tags`, 'security,auth')
        next.delete(`${paramPrefix}since`)
        next.delete(`${paramPrefix}until`)
        return next
      })
      return
    }
    if (id === 'preset:recent') {
      const d = new Date()
      d.setDate(d.getDate() - 30)
      const thirtyDaysAgo = d.toISOString().slice(0, 10)
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete(`${paramPrefix}types`)
        next.delete(`${paramPrefix}tags`)
        next.set(`${paramPrefix}since`, thirtyDaysAgo)
        next.delete(`${paramPrefix}until`)
        return next
      })
      return
    }

    const custom = perspectives.find((p) => p.id === id)
    if (custom) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (custom.filters.types?.length) next.set(`${paramPrefix}types`, custom.filters.types.join(','))
        else next.delete(`${paramPrefix}types`)

        if (custom.filters.tags?.length) next.set(`${paramPrefix}tags`, custom.filters.tags.join(','))
        else next.delete(`${paramPrefix}tags`)

        if (custom.filters.since) next.set(`${paramPrefix}since`, custom.filters.since)
        else next.delete(`${paramPrefix}since`)

        if (custom.filters.until) next.set(`${paramPrefix}until`, custom.filters.until)
        else next.delete(`${paramPrefix}until`)

        if (custom.filters.colorMode) next.set('color', custom.filters.colorMode)
        else next.delete('color')
        return next
      })
    }
  }

  async function handleSavePerspective(e: React.FormEvent) {
    e.preventDefault()
    if (!newPerspectiveName.trim()) return
    try {
      const colorMode = searchParams.get('color') ?? undefined
      const created = await saveGraphPerspective({
        name: newPerspectiveName.trim(),
        vaultId: effectiveVaultId || null,
        filters: { ...filters, colorMode },
        isShared: newPerspectiveShared,
      })
      setPerspectives((prev) => [...prev, created])
      setSelectedPerspectiveId(created.id)
      setIsSaving(false)
      setNewPerspectiveName('')
    } catch {
      // ignore
    }
  }

  async function handleDeletePerspective() {
    if (!selectedPerspectiveId || selectedPerspectiveId.startsWith('preset:') || selectedPerspectiveId === 'all') return
    try {
      await deleteGraphPerspective(selectedPerspectiveId)
      setPerspectives((prev) => prev.filter((p) => p.id !== selectedPerspectiveId))
      setSelectedPerspectiveId('all')
    } catch {
      // ignore
    }
  }

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
    setSelectedPerspectiveId('all')
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const key of FILTER_KEYS) next.delete(`${paramPrefix}${key}`)
      return next
    })
  }

  return (
    // Flat on purpose: since the command redesign this renders inside the
    // inspector's Filters section, which owns the border and the title.
    <div className="flex flex-col gap-3 text-sm">
      <span className="text-xs text-muted-foreground">
        {activeCount === 0 ? 'No filters active' : `${activeCount} filter${activeCount === 1 ? '' : 's'} active`}
      </span>

      {paramPrefix === '' && (
        <div className="flex flex-col gap-2 rounded border border-border/60 bg-muted/20 p-2">
          <div className="flex items-center justify-between gap-1.5">
            <label htmlFor="graph-perspective-select" className="text-xs font-medium text-foreground">
              Perspective
            </label>
            <div className="flex items-center gap-1.5">
              {selectedPerspectiveId !== 'all' && !selectedPerspectiveId.startsWith('preset:') && (
                <button
                  type="button"
                  onClick={handleDeletePerspective}
                  className="text-[11px] text-destructive hover:underline"
                >
                  Delete
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsSaving((v) => !v)}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                {isSaving ? 'Cancel' : '+ Save view'}
              </button>
            </div>
          </div>

          <select
            id="graph-perspective-select"
            aria-label="Graph perspective"
            value={selectedPerspectiveId}
            onChange={(e) => handleSelectPerspective(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <optgroup label="Presets">
              <option value="all">All Nodes (Reset)</option>
              <option value="preset:arch">Architecture & Specs</option>
              <option value="preset:security">Security & Auth</option>
              <option value="preset:recent">Recent (30 Days)</option>
            </optgroup>
            {perspectives.length > 0 && (
              <optgroup label="Saved Perspectives">
                {perspectives.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.isShared ? '' : ' (Private)'}
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          {isSaving && (
            <form onSubmit={handleSavePerspective} className="mt-1 flex flex-col gap-1.5 pt-1.5 border-t border-border/40">
              <input
                type="text"
                aria-label="Perspective name"
                placeholder="Perspective name..."
                value={newPerspectiveName}
                onChange={(e) => setNewPerspectiveName(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus
              />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newPerspectiveShared}
                    onChange={(e) => setNewPerspectiveShared(e.target.checked)}
                    className="rounded border-border text-xs"
                  />
                  Share with team
                </label>
                <button
                  type="submit"
                  disabled={!newPerspectiveName.trim()}
                  className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </form>
          )}
        </div>
      )}

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
