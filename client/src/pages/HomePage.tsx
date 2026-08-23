import { lazy, Suspense } from 'react'
import { AppShell } from '../components/shell/AppShell.js'
import { GraphSkeleton } from '../components/graph/GraphSkeleton.js'
import { VaultEmptyState } from '../components/vault/VaultEmptyState.js'
import { Button } from '../components/ui/button.js'
import { useVaults } from '../hooks/useVaults.js'

// Loaded as a separate chunk, requested after first paint (spec decision 9) —
// this import must stay dynamic, never hoisted to a static import above.
const GraphCanvas = lazy(() => import('../components/graph/GraphCanvas.js'))

export function HomePage() {
  const vaults = useVaults()

  return (
    <AppShell>
      {vaults.isPending ? (
        <GraphSkeleton />
      ) : vaults.isError ? (
        // Ordered before the `.length === 0` check on purpose: when the
        // vaults fetch fails, `vaults.data` is undefined, so
        // `vaults.data?.length === 0` is false and a chain that only tests
        // for that falls through to the graph branch — rendering a stale
        // or blank graph over a failed fetch. Unit 1b's review caught this
        // exact shape; `isError` has to be checked before `data` is ever read.
        <div
          role="alert"
          className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center"
        >
          <h1 className="font-display text-2xl">We couldn&rsquo;t load your vaults.</h1>
          <p className="max-w-sm text-muted-foreground">{vaults.error.message}</p>
          <Button type="button" onClick={() => vaults.refetch()}>
            Retry
          </Button>
        </div>
      ) : vaults.data.length === 0 ? (
        <VaultEmptyState />
      ) : (
        <Suspense fallback={<GraphSkeleton />}>
          <GraphCanvas />
        </Suspense>
      )}
    </AppShell>
  )
}
