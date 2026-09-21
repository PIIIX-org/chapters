import type { FileSymbol } from '../../api/repositories.js'
import { Eyebrow } from '../ui/eyebrow.js'
import { cn } from '../../lib/utils.js'

interface SymbolOutlineProps {
  /** Shipped with the file's content, so the outline can never disagree with the text beside it. */
  symbols: FileSymbol[]
  /** Called with the symbol's 1-based start line. */
  onSelect: (startLine: number) => void
}

const KIND_BADGE_STYLES: Record<string, string> = {
  function:
    'text-[var(--ink-indigo,#7c8fd9)] bg-[var(--ink-indigo,#7c8fd9)]/10 border-[var(--ink-indigo,#7c8fd9)]/30',
  method:
    'text-[var(--ink-indigo,#7c8fd9)] bg-[var(--ink-indigo,#7c8fd9)]/10 border-[var(--ink-indigo,#7c8fd9)]/30',
  class:
    'text-[var(--ink-ochre,#d9b24c)] bg-[var(--ink-ochre,#d9b24c)]/10 border-[var(--ink-ochre,#d9b24c)]/30',
  interface:
    'text-[var(--ink-plum,#c97fb0)] bg-[var(--ink-plum,#c97fb0)]/10 border-[var(--ink-plum,#c97fb0)]/30',
  type:
    'text-[var(--ink-forest,#6fbf8a)] bg-[var(--ink-forest,#6fbf8a)]/10 border-[var(--ink-forest,#6fbf8a)]/30',
  enum:
    'text-[var(--ink-ochre,#d9b24c)] bg-[var(--ink-ochre,#d9b24c)]/10 border-[var(--ink-ochre,#d9b24c)]/30',
}

/**
 * A file's declared symbols, per file and on demand
 * (`2026-07-18-code-graph-integration-design.md` §9). These are deliberately
 * *not* graph nodes — nothing here puts a function on the canvas; it is a
 * jump list for the file open beside it, living in the inspector's Symbols
 * tab.
 */
export function SymbolOutline({ symbols, onSelect }: SymbolOutlineProps) {
  return (
    <nav aria-label="Symbol outline" className="flex flex-col gap-2">
      <Eyebrow as="h2">Outline</Eyebrow>
      {symbols.length === 0 ? (
        // An unparsed language and a file with no declarations look the same
        // from here, and both are ordinary — say so instead of showing a
        // blank column that reads as a failure.
        <p className="text-xs text-muted-foreground">
          No symbols in this file. Chapters extracts an outline only from the languages it parses; the
          code itself still reads normally.
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {symbols.map((symbol) => (
            <li key={`${symbol.startLine}:${symbol.name}`}>
              <button
                type="button"
                onClick={() => onSelect(symbol.startLine)}
                aria-label={`${symbol.name}, ${symbol.kind}, line ${symbol.startLine}`}
                className="group flex w-full items-center gap-2 rounded-[var(--radius-sm,2px)] px-2 py-1 text-left outline-none transition-colors duration-100 select-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {symbol.name}
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded-[var(--radius-sm,2px)] border px-1.5 py-0.5 font-mono text-[10px] leading-none',
                    KIND_BADGE_STYLES[symbol.kind.toLowerCase()] ??
                      'border-border/60 bg-muted/60 text-muted-foreground',
                  )}
                >
                  {symbol.kind}
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                  {symbol.startLine}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}
