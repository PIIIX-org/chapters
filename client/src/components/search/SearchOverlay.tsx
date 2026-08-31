import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { matchPath, useLocation, useNavigate, useSearchParams } from 'react-router'
import {
  Code,
  FilePlus,
  FileText,
  FolderPlus,
  GitBranch,
  Library,
  Plug,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  SunMoon,
  Users,
  Waypoints,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Eyebrow } from '../ui/eyebrow.js'
import { Kbd } from '../ui/kbd.js'
import { Pill } from '../ui/pill.js'
import { useSearch } from '../../hooks/useSearch.js'
import { useVaults } from '../../hooks/useVaults.js'
import { useRepositories } from '../../hooks/useRepositories.js'
import { useCreateVault } from '../../hooks/useVaultMutations.js'
import { useCreateNote } from '../../hooks/useCreateNote.js'
import { useSession } from '../../hooks/useSession.js'
import { useTheme } from '../../hooks/useTheme.js'
import { GraphFilters, graphFiltersFromSearchParams, type FilterableNode } from '../graph/GraphFilters.js'
import { ConnectRepositoryDialog } from '../repositories/ConnectRepositoryDialog.js'
import { cn } from '../../lib/utils.js'
import { canEdit, type VaultAccess } from '../../api/vaults.js'
import type { AccessibleRepository } from '../../api/repositories.js'
import type { SearchResult } from '../../api/search.js'
import type { ThemePreference } from '../../lib/theme.js'
import { recentsStore, type Recent, type RecentKind } from './recents.js'

interface SearchOverlayProps {
  open: boolean
  onClose: () => void
}

interface Command {
  id: string
  /** The whole sentence assistive tech gets ("Open vault: Recipes"); also what the query filters on. */
  name: string
  /** What sighted people read on the row. */
  label: string
  /** Mono hint on the right: a path, an access level, the next theme. */
  hint?: string
  /** Shell shortcut, rendered as a Kbd. */
  kbd?: string
  icon: LucideIcon
  run: () => void | Promise<void>
}

interface CommandGroup {
  id: string
  title: string
  /** Accessible-name prefix for each row: "Command: …" or "Recent: …". */
  prefix: 'Command' | 'Recent'
  commands: Command[]
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

function tagsOf(r: SearchResult): string[] {
  const tags = (r.frontmatter as { tags?: unknown } | undefined)?.tags
  return Array.isArray(tags) && tags.every((t) => typeof t === 'string') ? (tags as string[]) : []
}

// Mirrors the rail (Rail.tsx) and its chords (useShellChords.ts) — same
// destinations, same order, same keys — so the palette never offers a door
// the rail does not have.
const AREAS: { id: string; label: string; to: string; icon: LucideIcon; kbd: string; admin?: boolean }[] = [
  { id: 'graph', label: 'Graph', to: '/', icon: Waypoints, kbd: 'g g' },
  { id: 'vaults', label: 'Vaults', to: '/vaults', icon: Library, kbd: 'g v' },
  { id: 'repos', label: 'Repositories', to: '/repos', icon: GitBranch, kbd: 'g r' },
  { id: 'team', label: 'Team', to: '/team', icon: Users, kbd: 'g t' },
  { id: 'settings', label: 'Settings', to: '/settings', icon: Settings2, kbd: 'g s' },
  { id: 'admin', label: 'Admin', to: '/admin', icon: ShieldCheck, kbd: 'g a', admin: true },
]

const ACCESS_HINT: Record<VaultAccess, string> = {
  owner: 'owner',
  edit: 'can edit',
  read: 'read only',
}

const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
}

const RECENT_ICON: Record<RecentKind, LucideIcon> = {
  area: Waypoints,
  vault: Library,
  repo: GitBranch,
  note: FileText,
}

function repoHint(r: AccessibleRepository): string {
  if (r.gitUrl) return r.gitUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '')
  if (r.localPath) return r.localPath
  return r.ingestionMethod
}

// Same slug rule NewNoteForm enforces, as one `type/name` token — the only
// shape the server's create-note route accepts.
const NOTE_PATH = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/

function Hint({ children }: { children: ReactNode }) {
  return <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-faint">{children}</span>
}

export function SearchOverlay({ open, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [activeIndex, setActiveIndex] = useState(0)
  const [prevEntriesKey, setPrevEntriesKey] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const vaults = useVaults()
  const repositories = useRepositories()
  const session = useSession()
  const theme = useTheme()
  const createVault = useCreateVault()
  const recents = useSyncExternalStore(recentsStore.subscribe, recentsStore.get, recentsStore.get)

  // "New note here" only means something inside a vault: the route says
  // which one, the list says whether this person may write to it.
  const currentVaultId = matchPath('/vaults/:vaultId/*', location.pathname)?.params.vaultId ?? null
  const currentVault = (vaults.data ?? []).find((v) => v.id === currentVaultId)
  const editableVault = currentVault && canEdit(currentVault.access) ? currentVault : null
  const createNote = useCreateNote(currentVaultId ?? '')

  // Same `vault` param the shell's ScopePicker owns (client/src/components/
  // shell/ScopePicker.tsx) — reading and writing it here, rather than a
  // second piece of state, is what keeps the two controls agreeing about
  // scope after ⌘K closes.
  const vaultId = searchParams.get('vault')
  // 's_'-prefixed: namespaced separately from the graph's own ?types=/?tags=/
  // etc. so the two filter panels mounted at once (Home's graph, and this
  // overlay) never silently read or write each other's params.
  const filters = graphFiltersFromSearchParams(searchParams, 's_')
  const activeFilterCount =
    (filters.types?.length ?? 0) + (filters.tags?.length ?? 0) + (filters.since ? 1 : 0) + (filters.until ? 1 : 0)

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

  function visit(recent: Recent) {
    recentsStore.record(recent)
    navigate(recent.path)
  }

  function go(containerId: string, path: string) {
    onClose()
    visit({ kind: 'note', label: path, path: `/vaults/${containerId}/notes/${path}` })
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
  const lowerQuery = trimmedQuery.toLowerCase()
  const matches = (cmd: Command) => lowerQuery === '' || cmd.name.toLowerCase().includes(lowerQuery)

  // ---- Actions -----------------------------------------------------------
  const actions: Command[] = []
  const notePath = NOTE_PATH.exec(trimmedQuery)
  // Only offered when it can really be done: inside a vault this person can
  // write to, with a `type/name` typed. A row that lands nowhere is worse
  // than none, so there is no placeholder "new note" that merely reopens the
  // vault you are already in — the footer explains the shape instead.
  if (editableVault && notePath) {
    const vault = editableVault
    const [, type = '', name = ''] = notePath
    const path = `${type}/${name}`
    actions.push({
      id: 'create-note',
      name: `New note ${path} in ${vault.name}`,
      label: `New note in ${vault.name}`,
      hint: path,
      icon: FilePlus,
      run: async () => {
        const note = await createNote.mutateAsync({ type, name })
        visit({ kind: 'note', label: note.path, path: `/vaults/${vault.id}/notes/${note.path}` })
      },
    })
  }
  if (trimmedQuery) {
    actions.push({
      id: 'create-vault',
      name: `New vault "${trimmedQuery}"`,
      label: `New vault "${trimmedQuery}"`,
      icon: FolderPlus,
      run: async () => {
        const vault = await createVault.mutateAsync(trimmedQuery)
        navigate(`/vaults/${vault.id}`)
      },
    })
  }
  actions.push(
    // Not a destination, and deliberately not conditioned on the repository
    // list: ConnectRepositoryDialog otherwise mounts only inside
    // RepositoryPage, reachable only from the repository rows below — so
    // someone with no repositories had no route to their first one. Same
    // cold start vault creation hit in unit 1.
    { id: 'connect-repo', name: 'Connect a repository', label: 'Connect a repository', icon: Plug, run: () => setConnecting(true) },
    {
      id: 'theme',
      name: 'Switch theme',
      label: 'Switch theme',
      hint: `${theme.preference} → ${NEXT_THEME[theme.preference]}`,
      icon: SunMoon,
      run: () => theme.setPreference(NEXT_THEME[theme.preference]),
    },
  )

  // ---- Recent (before typing only) --------------------------------------
  const recentCommands: Command[] =
    lowerQuery === ''
      ? recents.map((r) => ({
          id: `recent:${r.path}`,
          name: r.label,
          label: r.label,
          hint: r.path,
          icon: RECENT_ICON[r.kind],
          run: () => visit(r),
        }))
      : []

  // ---- Go to ---------------------------------------------------------------
  // Destinations are limited to routes that exist in router.tsx today. Do NOT
  // add a row for a page a later unit has not shipped yet.
  const isAdmin = session.data?.role === 'admin'
  const areaCommands: Command[] = AREAS.filter((a) => !a.admin || isAdmin).map((a) => ({
    id: a.id,
    name: `Go to ${a.label.toLowerCase()}`,
    label: a.label,
    hint: a.to,
    kbd: a.kbd,
    icon: a.icon,
    // Admins only: /admin renders a "this area is for admins" wall to everyone
    // else, and offering a door that opens onto that is worse than no door.
    run: () => visit({ kind: 'area', label: a.label, path: a.to }),
  }))

  const vaultCommands: Command[] = (vaults.data ?? []).map((v) => ({
    id: `vault:${v.id}`,
    name: `Open vault: ${v.name}`,
    label: v.name,
    hint: ACCESS_HINT[v.access],
    icon: Library,
    run: () => visit({ kind: 'vault', label: v.name, path: `/vaults/${v.id}` }),
  }))

  const repoCommands: Command[] = (repositories.data ?? []).map((r) => ({
    id: `repo:${r.id}`,
    name: `Open repository: ${r.name}`,
    label: r.name,
    hint: repoHint(r),
    icon: GitBranch,
    run: () => visit({ kind: 'repo', label: r.name, path: `/repos/${r.id}/files` }),
  }))

  const allGroups: CommandGroup[] = [
    { id: 'actions', title: 'Actions', prefix: 'Command', commands: actions.filter(matches) },
    { id: 'recent', title: 'Recent', prefix: 'Recent', commands: recentCommands },
    { id: 'go', title: 'Go to', prefix: 'Command', commands: areaCommands.filter(matches) },
    { id: 'vaults', title: 'Vaults', prefix: 'Command', commands: vaultCommands.filter(matches) },
    { id: 'repos', title: 'Repositories', prefix: 'Command', commands: repoCommands.filter(matches) },
  ]
  const groups = allGroups.filter((g) => g.commands.length > 0)

  function runCommand(cmd: Command) {
    void Promise.resolve(cmd.run())
      .then(() => onClose())
      .catch(() => {
        // Swallowed here on purpose: the only commands whose run() can reject
        // are create-vault and create-note, and their own mutations'
        // isError/error (rendered below) are what surface the failure. Every
        // other run() is a bare navigate()/setState and cannot reject.
      })
  }

  // The keyboard drives this flat list in order: command groups, then
  // results. It mirrors render order exactly, so an entry's position here is
  // also its position in the rendered groups below.
  const entries: Entry[] = [
    ...groups.flatMap((g) => g.commands.map((cmd) => ({ id: commandOptionId(cmd), activate: () => runCommand(cmd) }))),
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

  const mutationError = createVault.isError
    ? createVault.error.message
    : createNote.isError
      ? createNote.error.message
      : null

  const noteHint = editableVault && !notePath ? editableVault : null

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onKeyDown={onPanelKeyDown}
            className="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-popover text-foreground shadow-floating"
          >
            <div className="flex h-11 items-center gap-2.5 border-b border-border px-3">
              <Search aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={entries.length > 0}
                aria-controls="search-listbox"
                aria-activedescendant={entries[activeIndex]?.id}
                aria-label="Search notes, code, or jump anywhere"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search notes, code, or jump anywhere…"
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
              />
              <Kbd aria-hidden="true">esc</Kbd>
            </div>
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
              <Eyebrow className="mr-1">Scope</Eyebrow>
              <div role="radiogroup" aria-label="Search scope" className="flex flex-wrap gap-1">
                <ScopeChip checked={!vaultId} onClick={() => selectScope(null)}>
                  Everywhere
                </ScopeChip>
                {(vaults.data ?? []).map((v) => (
                  <ScopeChip key={v.id} checked={vaultId === v.id} onClick={() => selectScope(v.id)}>
                    {v.name}
                  </ScopeChip>
                ))}
              </div>
              <button
                type="button"
                aria-expanded={filtersOpen}
                aria-controls="search-filters"
                onClick={() => setFiltersOpen((o) => !o)}
                className={cn(
                  'ml-auto inline-flex h-6 items-center gap-1 rounded-sm border border-transparent px-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground transition-colors duration-100 hover:bg-muted hover:text-foreground',
                  (filtersOpen || activeFilterCount > 0) && 'border-border bg-muted text-foreground',
                )}
              >
                <SlidersHorizontal aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
                Filters
                {activeFilterCount > 0 && <span>· {activeFilterCount}</span>}
              </button>
            </div>
            {filtersOpen && (
              <div id="search-filters" className="border-b border-border p-2">
                <GraphFilters nodes={filterNodes} paramPrefix="s_" />
              </div>
            )}
            {mutationError && (
              <div role="alert" className="border-b border-border px-3 py-2 text-[13px] text-destructive">
                {mutationError}
              </div>
            )}
            <div id="search-listbox" role="listbox" aria-label="Commands and results" className="max-h-[50vh] overflow-auto py-1">
              {groups.map((group) => (
                <div key={group.id} role="group" aria-label={group.title}>
                  <Eyebrow as="div" className="px-3 pb-1 pt-2">
                    {group.title}
                  </Eyebrow>
                  {group.commands.map((cmd) => {
                    const optionId = commandOptionId(cmd)
                    const isActive = activeEntryId === optionId
                    return (
                      <button
                        key={cmd.id}
                        id={optionId}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        aria-label={`${group.prefix}: ${cmd.name}`}
                        onClick={() => runCommand(cmd)}
                        className={cn(
                          'flex h-9 w-full items-center gap-2.5 px-3 text-left text-[13px] text-foreground hover:bg-muted',
                          isActive && 'bg-muted',
                        )}
                      >
                        <cmd.icon aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                        {cmd.hint && <Hint>{cmd.hint}</Hint>}
                        {cmd.kbd && <Kbd aria-hidden="true">{cmd.kbd}</Kbd>}
                      </button>
                    )
                  })}
                </div>
              ))}
              {!results.isError && debounced.trim() && (
                <div role="group" aria-label="Results">
                  <Eyebrow as="div" className="px-3 pb-1 pt-2">
                    Results
                  </Eyebrow>
                  {items.map((r) => {
                    const key = resultKey(r)
                    const optionId = resultOptionId(r)
                    const isActive = activeEntryId === optionId
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
                          className={cn('block w-full px-3 py-2 text-left hover:bg-muted', isActive && 'bg-muted')}
                        >
                          <div className="flex items-center gap-2.5">
                            <Code aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{r.path}</span>
                            {r.language && <Pill>{r.language}</Pill>}
                            <Hint>{r.score.toFixed(2)}</Hint>
                          </div>
                          {isExpanded && (
                            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-2 font-mono text-xs text-muted-foreground">
                              {r.snippet}
                            </pre>
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
                        className={cn('block w-full px-3 py-2 text-left hover:bg-muted', isActive && 'bg-muted')}
                      >
                        <div className="flex items-center gap-2.5">
                          <FileText aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{r.path}</span>
                          {r.type && <Pill>{r.type}</Pill>}
                          {tags.map((tag) => (
                            <Pill key={tag}>{tag}</Pill>
                          ))}
                          <Hint>{r.score.toFixed(2)}</Hint>
                        </div>
                        <div className="truncate pl-[26px] text-xs text-muted-foreground">{r.snippet}</div>
                      </button>
                    )
                  })}
                  {results.isPending && (
                    <div className="px-3 py-2 font-mono text-[11px] text-faint">Searching…</div>
                  )}
                  {!results.isPending && items.length === 0 && (
                    <div className="px-3 py-2 text-[13px] text-muted-foreground">No results found.</div>
                  )}
                </div>
              )}
            </div>
            {results.isError && (
              // Sibling of #search-listbox, not a descendant: role="listbox"
              // permits only option/group children (aria-required-children), and
              // this alert plus its focusable Retry button are neither.
              <div role="alert" className="border-t border-border px-3 py-2 text-[13px]">
                <p className="text-destructive">{results.error?.message ?? 'Search failed.'}</p>
                <button
                  type="button"
                  onClick={() => results.refetch()}
                  className="mt-1 rounded-sm border border-border bg-muted px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.04em] text-foreground hover:border-input"
                >
                  Retry
                </button>
              </div>
            )}
            <div className="flex h-8 items-center gap-3 border-t border-border bg-secondary px-3 font-mono text-[11px] text-faint">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> move
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> open
              </span>
              {noteHint && (
                <span className="ml-auto truncate">
                  <span className="text-muted-foreground">type/name</span> creates a note in {noteHint.name}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Outside the `open` branch on purpose: the command that opens this
          closes ⌘K in the same tick, and a dialog living in the subtree that
          just went away would close with it. */}
      <ConnectRepositoryDialog
        open={connecting}
        onOpenChange={setConnecting}
        onConnected={(created) => navigate(`/repos/${created.id}/files`)}
      />
    </>
  )
}

function ScopeChip({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 items-center rounded-sm border px-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] transition-colors duration-100',
        checked
          ? 'border-border bg-muted text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
