import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Kbd } from '../ui/kbd.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'
import { useShell } from './shell-context.js'
import { MOD_KEY_LABEL } from '../../lib/platform.js'
import { cn } from '../../lib/utils.js'

/**
 * Top-right search button that smoothly expands horizontally to the left
 * into a full search input bar when clicked, per the Observatory Bridge design.
 */
export function ExpandableSearch() {
  const shell = useShell()
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function openSearch() {
    setExpanded(true)
  }

  function closeSearch() {
    setExpanded(false)
    setQuery('')
  }

  // Focus input on expand
  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus()
    }
  }, [expanded])

  // Click outside to collapse
  useEffect(() => {
    if (!expanded) return
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        closeSearch()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [expanded])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      shell.openPalette()
    }
  }

  return (
    <div ref={containerRef} className="relative flex items-center justify-end">
      {expanded ? (
        <div
          className={cn(
            'flex h-9 w-[280px] sm:w-[460px] lg:w-[560px] items-center gap-2 rounded-[var(--radius-md)] border border-border bg-card px-2.5 shadow-floating transition-all duration-200 ease-in-out',
          )}
        >
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search notes, code, or jump anywhere…"
            aria-label="Search notes, code, or jump anywhere…"
            className="flex-1 min-w-0 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground outline-none"
          />
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => shell.openPalette()}
              className="flex items-center gap-1 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              <Kbd aria-hidden="true">{MOD_KEY_LABEL} K</Kbd>
            </button>
            <button
              type="button"
              onClick={closeSearch}
              aria-label="Close search"
              className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={openSearch}
              aria-label="Open the command palette"
              aria-keyshortcuts="Meta+K Control+K"
              className="flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-border bg-card text-muted-foreground outline-none transition-all duration-150 hover:bg-muted hover:text-foreground active:scale-95 shadow-floating focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Search className="size-4" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Search notes, code, or jump anywhere
            <Kbd aria-hidden="true">{MOD_KEY_LABEL} K</Kbd>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
