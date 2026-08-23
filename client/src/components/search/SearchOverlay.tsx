import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { Input } from '../ui/input.js'
import { useSearch } from '../../hooks/useSearch.js'
import { useVaults } from '../../hooks/useVaults.js'
import { useCreateVault } from '../../hooks/useVaultMutations.js'
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
  const navigate = useNavigate()
  const vaults = useVaults()
  const createVault = useCreateVault()

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(id)
  }, [query])

  // When closed, disable the query so a leftover search doesn't background-
  // refetch on window refocus (the overlay is always mounted). Reopening
  // re-enables with the last query.
  const results = useSearch(open ? debounced : '', null, {})
  const items = results.data ?? []

  if (!open) return null

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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
  }

  const trimmedQuery = query.trim()
  const lowerQuery = query.toLowerCase()

  // Command destinations are limited to routes that actually exist in
  // router.tsx today. Do NOT add settings/team/admin/invite commands here
  // until a later unit ships those pages — a command that goes nowhere is
  // worse than no command at all.
  const navCommands: Command[] = [
    { id: 'home', label: 'Go to graph home', run: () => navigate('/') },
    ...(vaults.data ?? []).map((v) => ({
      id: `vault:${v.id}`,
      label: `Open vault: ${v.name}`,
      run: () => navigate(`/vaults/${v.id}`),
    })),
  ].filter((c) => c.label.toLowerCase().includes(lowerQuery))

  const commands: Command[] = [...navCommands]
  if (trimmedQuery) {
    commands.push({
      id: 'create-vault',
      label: `Create vault '${trimmedQuery}'`,
      run: async () => {
        const vault = await createVault.mutateAsync(trimmedQuery)
        navigate(`/vaults/${vault.id}`)
      },
    })
  }

  function runCommand(cmd: Command) {
    void Promise.resolve(cmd.run()).then(() => onClose())
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-background shadow-lg">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search notes and code…"
          className="h-11 rounded-none border-0 border-b border-border text-base focus-visible:ring-0"
        />
        {/* Not a single role="listbox" spanning commands + results: results mix
            true options (note rows) with a disclosure toggle (code preview),
            and role="option" cannot carry aria-expanded — an ARIA listbox
            requires every owned element to be option/group. Commands are a
            homogeneous set, so they get their own self-contained listbox;
            results stay plain buttons. Revisit once keyboard navigation
            unifies these into one real composite widget. */}
        <div className="max-h-[50vh] overflow-auto">
          {commands.length > 0 && (
            <div role="listbox" aria-label="Commands">
              {commands.map((cmd) => (
                <button
                  key={cmd.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  aria-label={`Command: ${cmd.label}`}
                  onClick={() => runCommand(cmd)}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-muted"
                >
                  <span aria-hidden="true" className="text-muted-foreground">
                    ›
                  </span>
                  <span className="truncate text-sm">{cmd.label}</span>
                </button>
              ))}
            </div>
          )}
          <div aria-label="Results">
            {results.isError ? (
              <div role="alert" className="px-4 py-3 text-sm">
                <p className="text-destructive">{results.error?.message ?? 'Search failed.'}</p>
                <button
                  type="button"
                  onClick={() => results.refetch()}
                  className="mt-1 rounded bg-muted px-2 py-1 text-xs"
                >
                  Retry
                </button>
              </div>
            ) : (
              <>
                {items.map((r) => {
                  const key = `${r.resourceType}:${r.id}`
                  if (r.resourceType === 'code') {
                    const isExpanded = expanded.has(key)
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-expanded={isExpanded}
                        onClick={() => toggleCode(key)}
                        className="block w-full px-4 py-2 text-left hover:bg-muted"
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
                      type="button"
                      onClick={() => go(r.containerId, r.path)}
                      className="block w-full px-4 py-2 text-left hover:bg-muted"
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
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
