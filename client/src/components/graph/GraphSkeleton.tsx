// Static placeholder shown while vaults are loading or while the graph
// renderer chunk (GraphCanvas) is being fetched. No animation library and no
// animated properties — per perf rule 6, any motion here would need to stay
// compositor-safe (opacity/transform only), but this skeleton has none at all.
export function GraphSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div aria-hidden="true" className="text-muted-foreground/40">
        <svg viewBox="0 0 320 200" className="h-56 w-80" fill="none" stroke="currentColor" strokeWidth="1.5">
          <line x1="60" y1="60" x2="160" y2="40" />
          <line x1="160" y1="40" x2="260" y2="80" />
          <line x1="60" y1="60" x2="120" y2="150" />
          <line x1="120" y1="150" x2="220" y2="160" />
          <line x1="220" y1="160" x2="260" y2="80" />
          <circle cx="60" cy="60" r="10" fill="currentColor" stroke="none" />
          <circle cx="160" cy="40" r="14" fill="currentColor" stroke="none" />
          <circle cx="260" cy="80" r="9" fill="currentColor" stroke="none" />
          <circle cx="120" cy="150" r="12" fill="currentColor" stroke="none" />
          <circle cx="220" cy="160" r="8" fill="currentColor" stroke="none" />
        </svg>
      </div>
      <span role="status" className="sr-only">
        Loading the graph
      </span>
    </div>
  )
}
