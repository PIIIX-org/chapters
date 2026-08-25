import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Input } from '../ui/input.js'
import { useSearch } from '../../hooks/useSearch.js'
import { useVaults } from '../../hooks/useVaults.js'
import { useCreateVault } from '../../hooks/useVaultMutations.js'
import { useSession } from '../../hooks/useSession.js'
import { GraphFilters, graphFiltersFromSearchParams, type FilterableNode } from '../graph/GraphFilters.js'
import { cn } from '../../lib/utils.js'
import type { SearchResult } from '../../api/search.js'

interface SearchOverlayProps {
  open: boolean
  onClose: () => void
}

interface Command {
  id: string
  label: string
  run: () => void | Promise<void>
}

// One flat, ordered entry — commands first, then results — is what the
// keyboard actually drives. Each entry owns the DOM id its <button
// role="option"> renders (so aria-activedescendant can point straight at it)
// and the exact action a click on that option performs, so Enter can just
// call it.
interface Entry {
  id: string
  activate: () => void
}

function commandOptionId(cmd: Command): string {
  return `search-option-cmd-${cmd.id}`
}

function resultKey(r: SearchResult): string {
  return `${r.resourceType}:${r.id}`
}

function resultOptionId(r: SearchResult): string {
  return `search-option-result-${resultKey(r)}`
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{children}</span>
}

function tagsOf(r: SearchResult): string[] {
  const tags = (r.frontmatter as { tags?: unknown } | undefined)?.tags
  return Array.isArray(tags) && tags.every((t) => typeof t === 'string') ? (tags as string[]) : []
}

export function SearchOverlay({ open, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [activeIndex, setActiveIndex] = useState(0)
  const [prevEntriesKey, setPrevEntriesKey] = useState('')
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const vaults = useVaults()
  const session = useSession()
  const createVault = useCreateVault()

  // Same `vault` param the shell's ScopePicker owns (client/src/components/
  // shell/ScopePicker.tsx) — reading and writing it here, rather than a
  // second piece of state, is what keeps the two controls agreeing about
  // scope after ⌘K closes.
  const vaultId = searchParams.get('vault')
  // 's_'-prefixed: namespaced separately from the graph's own ?types=/?tags=/
  // etc. so the two filter panels mounted at once (Home's graph, and this
  // overlay) never silently read or write each other's params.
  const filters = graphFiltersFromSearchParams(searchParams, 's_')

  function selectScope(id: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('vault', id)
      else next.delete('vault')
      return next
    })
  }

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(id)
  }, [query])

  // Whatever had focus before ⌘K opened gets it back on close, however the
  // overlay closes (Escape, backdrop click, a command/result activating) —
  // otherwise a user who opened ⌘K while editing a note is dumped at
  // <body> and loses their place.
  const previousFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    return () => {
      previousFocusRef.current?.focus()
    }
  }, [open])

  const panelRef = useRef<HTMLDivElement>(null)

  function onPanelKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  // When closed, disable the query so a leftover search doesn't background-
  // refetch on window refocus (the overlay is always mounted). Reopening
  // re-enables with the last query.
  const results = useSearch(open ? debounced : '', vaultId, filters)
  const items = results.data ?? []

  // Options for the filter panel come from the results actually loaded, not
  // a hardcoded list — narrows as the query and filters narrow, same
  // contract as GraphFilters' other caller (GraphCanvas's node set).
  const filterNodes: FilterableNode[] = items.map((r) => ({
    type: r.resourceType === 'code' ? (r.language ?? null) : (r.type ?? null),
    tags: Array.isArray((r.frontmatter as { tags?: unknown } | undefined)?.tags)
      ? ((r.frontmatter as { tags: string[] }).tags)
      : [],
  }))

  function go(containerId: string, path: string) {
    onClose()
    navigate(`/vaults/${containerId}/notes/${path}`)
  }

  function toggleCode(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const trimmedQuery = query.trim()
  const lowerQuery = query.toLowerCase()

  // Command destinations are limited to routes that actually exist in
  // router.tsx today. Do NOT add a command for a page a later unit has not
  // shipped yet — a command that goes nowhere is worse than no command at all.
  const navCommands: Command[] = [
    { id: 'home', label: 'Go to graph home', run: () => navigate('/') },
    ...(vaults.data ?? []).map((v) => ({
      id: `vault:${v.id}`,
      label: `Open vault: ${v.name}`,
      run: () => navigate(`/vaults/${v.id}`),
    })),
    { id: 'team', label: 'Go to team', run: () => navigate('/team') },
    // Admins only: /admin renders a "this area is for admins" wall to everyone
    // else, and offering a door that opens onto that is worse than no door.
    ...(session.data?.role === 'admin'
      ? [{ id: 'admin', label: 'Go to admin', run: () => navigate('/admin') }]
      : []),
  ].filter((c) => c.label.toLowerCase().includes(lowerQuery))

  const commands: Command[] = [...navCommands]
  if (trimmedQuery) {
    commands.push({
      id: 'create-vault',
      label: `Create vault "${trimmedQuery}"`,
      run: async () => {
        const vault = await createVault.mutateAsync(trimmedQuery)
        navigate(`/vaults/${vault.id}`)
      },
    })
  }

  function runCommand(cmd: Command) {
    void Promise.resolve(cmd.run())
      .then(() => onClose())
      .catch(() => {
        // Swallowed here on purpose: the only command whose run() can reject
        // is create-vault, and its own mutation's isError/error (rendered
        // below) is what surfaces the failure. Nav commands' run() is a bare
        // navigate() call and cannot reject.
      })
  }

  // The keyboard drives this flat list in order: commands, then results. It
  // mirrors render order exactly, so an entry's position here is also its
  // position in the two rendered groups below.
  const entries: Entry[] = [
    ...commands.map((cmd) => ({ id: commandOptionId(cmd), activate: () => runCommand(cmd) })),
    ...(results.isError
      ? []
      : items.map((r) => ({
          id: resultOptionId(r),
          activate: () => (r.resourceType === 'code' ? toggleCode(resultKey(r)) : go(r.containerId, r.path)),
        }))),
  ]

  // Reset the active index whenever the entry list's identity changes (new
  // query, new results, new command set) so a stale index can never survive
  // into a later Enter — that's how a keystroke ends up activating the wrong
  // row, or silently no-oping past the end of a shrunk list. Adjusted during
  // render (React's documented pattern for "reset state when a computed key
  // changes") rather than in an effect, which would cascade an extra render.
  const entriesKey = entries.map((e) => e.id).join('|')
  if (entriesKey !== prevEntriesKey) {
    setPrevEntriesKey(entriesKey)
    setActiveIndex(0)
  }

  // The listbox scrolls (max-h-[50vh] overflow-auto); without this, arrowing
  // past the fold moves the active option off-screen with nothing visible to
  // follow it.
  const activeEntryId = entries[activeIndex]?.id
  useEffect(() => {
    if (!activeEntryId) return
    document.getElementById(activeEntryId)?.scrollIntoView({ block: 'nearest' })
  }, [activeEntryId])

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (entries.length === 0 ? 0 : (i + 1) % entries.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (entries.length === 0 ? 0 : (i - 1 + entries.length) % entries.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      entries[activeIndex]?.activate()
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={onPanelKeyDown}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-background shadow-lg"
      >
        <div className="flex items-center gap-1.5 border-b border-border px-4 py-2">
          <span className="text-xs font-medium text-muted-foreground">Search:</span>
          <div role="radiogroup" aria-label="Search scope" className="flex flex-wrap gap-1">
            <button
              type="button"
              role="radio"
              aria-checked={!vaultId}
              onClick={() => selectScope(null)}
              className={cn(
                'rounded px-1.5 py-0.5 text-xs font-medium hover:bg-muted',
                !vaultId && 'bg-muted text-foreground',
              )}
            >
              Everywhere
            </button>
            {(vaults.data ?? []).map((v) => (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={vaultId === v.id}
                onClick={() => selectScope(v.id)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-xs font-medium hover:bg-muted',
                  vaultId === v.id && 'bg-muted text-foreground',
                )}
              >
                {v.name}
              </button>
            ))}
          </div>
        </div>
        <Input
          autoFocus
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={entries.length > 0}
          aria-controls="search-listbox"
          aria-activedescendant={entries[activeIndex]?.id}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search notes and code…"
          className="h-11 rounded-none border-0 border-b border-border text-base focus-visible:ring-0"
        />
        <div className="border-b border-border p-2">
          <GraphFilters nodes={filterNodes} paramPrefix="s_" />
        </div>
        {createVault.isError && (
          <div role="alert" className="border-b border-border px-4 py-2 text-sm text-destructive">
            {createVault.error.message}
          </div>
        )}
        <div id="search-listbox" role="listbox" aria-label="Search" className="max-h-[50vh] overflow-auto">
          {commands.length > 0 && (
            <div role="group" aria-label="Commands">
              {commands.map((cmd, i) => (
                <button
                  key={cmd.id}
                  id={commandOptionId(cmd)}
                  type="button"
                  role="option"
                  aria-selected={activeIndex === i}
                  aria-label={`Command: ${cmd.label}`}
                  onClick={() => runCommand(cmd)}
                  className={cn(
                    'flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-muted',
                    activeIndex === i && 'bg-muted',
                  )}
                >
                  <span aria-hidden="true" className="text-muted-foreground">
                    ›
                  </span>
                  <span className="truncate text-sm">{cmd.label}</span>
                </button>
              ))}
            </div>
          )}
          {!results.isError && (
            <div role="group" aria-label="Results">
              <>
                {items.map((r, i) => {
                  const key = resultKey(r)
                  const optionId = resultOptionId(r)
                  const isActive = activeIndex === commands.length + i
                  if (r.resourceType === 'code') {
                    const isExpanded = expanded.has(key)
                    return (
                      <button
                        key={key}
                        id={optionId}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onClick={() => toggleCode(key)}
                        className={cn('block w-full px-4 py-2 text-left hover:bg-muted', isActive && 'bg-muted')}
                      >
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">Code</span>
                          <span className="truncate font-mono text-sm">{r.path}</span>
                          {r.language && <Chip>{r.language}</Chip>}
                          <span className="ml-auto font-mono text-xs text-muted-foreground">{r.score.toFixed(2)}</span>
                        </div>
                        {isExpanded && (
                          <div className="mt-2 rounded bg-muted p-2">
                            <div className="font-mono text-xs">{r.path}</div>
                            <div className="text-xs text-muted-foreground">{r.language}</div>
                            <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{r.snippet}</pre>
                          </div>
                        )}
                      </button>
                    )
                  }

                  const tags = tagsOf(r)
                  return (
                    <button
                      key={key}
                      id={optionId}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => go(r.containerId, r.path)}
                      className={cn('block w-full px-4 py-2 text-left hover:bg-muted', isActive && 'bg-muted')}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate font-mono text-sm">{r.path}</div>
                        <span className="font-mono text-xs text-muted-foreground">{r.score.toFixed(2)}</span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{r.snippet}</div>
                      {(r.type || tags.length > 0) && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {r.type && <Chip>{r.type}</Chip>}
                          {tags.map((tag) => (
                            <Chip key={tag}>{tag}</Chip>
                          ))}
                        </div>
                      )}
                    </button>
                  )
                })}
                {debounced.trim() && !results.isPending && items.length === 0 && (
                  <div className="px-4 py-3 text-sm text-muted-foreground">No results found.</div>
                )}
              </>
            </div>
          )}
        </div>
        {results.isError && (
          // Sibling of #search-listbox, not a descendant: role="listbox"
          // permits only option/group children (aria-required-children), and
          // this alert plus its focusable Retry button are neither.
          <div role="alert" className="border-t border-border px-4 py-3 text-sm">
            <p className="text-destructive">{results.error?.message ?? 'Search failed.'}</p>
            <button
              type="button"
              onClick={() => results.refetch()}
              className="mt-1 rounded bg-muted px-2 py-1 text-xs"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
