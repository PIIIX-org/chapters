import type { FileSymbol } from '../../api/repositories.js'

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
 * jump list for the file open beside it.
 */
export function SymbolOutline({ symbols, onSelect }: SymbolOutlineProps) {
  return (
    <nav aria-label="Symbol outline" className="flex flex-col gap-2">
      <h2 className="font-display text-sm text-foreground">Outline</h2>
      {symbols.length === 0 ? (
        // An unparsed language and a file with no declarations look the same
        // from here, and both are ordinary — say so instead of showing a
        // blank column that reads as a failure.
        <p className="text-xs text-muted-foreground">
          No symbols in this file. Chapters extracts an outline only from the languages it parses; the
          code itself still reads normally.
        </p>
      ) : (
        <ul className="flex flex-col">
          {symbols.map((symbol) => (
            <li key={`${symbol.startLine}:${symbol.name}`}>
              <button
                type="button"
                onClick={() => onSelect(symbol.startLine)}
                aria-label={`${symbol.name}, ${symbol.kind}, line ${symbol.startLine}`}
                className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-muted"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {symbol.name}
                </span>
                <span className="text-[0.7rem] text-muted-foreground">{symbol.kind}</span>
                <span className="font-mono text-[0.7rem] text-muted-foreground">{symbol.startLine}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}
