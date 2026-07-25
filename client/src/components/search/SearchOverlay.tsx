import { useEffect, useState } from 'react'
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

  const results = useSearch(debounced)
  const notes = (results.data ?? []).filter((r) => r.resourceType === 'note')

  if (!open) return null

  function go(containerId: string, path: string) {
    onClose()
    navigate(`/vaults/${containerId}/notes/${path}`)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
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
        <ul className="max-h-[50vh] overflow-auto">
          {notes.map((r) => (
            <li key={`${r.resourceType}:${r.id}`}>
              <button
                type="button"
                onClick={() => go(r.containerId, r.path)}
                className="block w-full px-4 py-2 text-left hover:bg-muted"
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
