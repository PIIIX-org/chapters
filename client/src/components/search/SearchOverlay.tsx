import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { Input } from '../ui/input'
import { useSearch } from '../../hooks/useSearch'

interface SearchOverlayProps {
  open: boolean
  onClose: () => void
}

export function SearchOverlay({ open, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(id)
  }, [query])

  const [active, setActive] = useState(0)
  // New query -> results change -> restart selection at the top.
  useEffect(() => setActive(0), [debounced])

  // When closed, disable the query so a leftover search doesn't background-
  // refetch on window refocus (the overlay is always mounted). Reopening
  // re-enables with the last query.
  const results = useSearch(open ? debounced : '')
  const notes = (results.data ?? []).filter((r) => r.resourceType === 'note')

  const activeIndex = notes.length ? Math.min(active, notes.length - 1) : 0
  const activeRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  function go(containerId: string, path: string) {
    onClose()
    navigate(`/vaults/${containerId}/notes/${path}`)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, notes.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = notes[activeIndex]
      if (r) go(r.containerId, r.path)
    }
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
          placeholder="Search notes…"
          className="h-11 rounded-none border-0 border-b border-border text-base focus-visible:ring-0"
        />
        <ul role="listbox" className="max-h-[50vh] overflow-auto">
          {notes.map((r, i) => (
            <li
              key={`${r.resourceType}:${r.id}`}
              ref={i === activeIndex ? activeRef : undefined}
              role="option"
              aria-selected={i === activeIndex}
            >
              <button
                type="button"
                onClick={() => go(r.containerId, r.path)}
                onMouseMove={() => setActive(i)}
                className={`block w-full px-4 py-2 text-left ${i === activeIndex ? 'bg-muted' : ''}`}
              >
                <div className="text-sm">{r.path}</div>
                <div className="truncate text-xs text-muted-foreground">{r.snippet}</div>
              </button>
            </li>
          ))}
          {debounced.trim() && !results.isPending && notes.length === 0 && (
            <li className="px-4 py-3 text-sm text-muted-foreground">No notes found.</li>
          )}
        </ul>
      </div>
    </div>
  )
}
