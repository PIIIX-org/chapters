import type { FileSymbol } from '../../api/repositories.js'
import { Eyebrow } from '../ui/eyebrow.js'

interface SymbolOutlineProps {
  /** Shipped with the file's content, so the outline can never disagree with the text beside it. */
  symbols: FileSymbol[]
  /** Called with the symbol's 1-based start line. */
  onSelect: (startLine: number) => void
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
                className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {symbol.name}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{symbol.kind}</span>
                <span className="shrink-0 font-mono text-[11px] text-faint">{symbol.startLine}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}
