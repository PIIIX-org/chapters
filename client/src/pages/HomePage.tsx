import { lazy, Suspense } from 'react'
import { GraphSkeleton } from '../components/graph/GraphSkeleton.js'
import { ScopePicker } from '../components/shell/ScopePicker.js'
import { useShellBreadcrumb } from '../components/shell/shell-context.js'
import { VaultEmptyState } from '../components/vault/VaultEmptyState.js'
import { PanelState } from '../components/ui/empty-state.js'
import { useVaults } from '../hooks/useVaults.js'

// Loaded as a separate chunk, requested after first paint (spec decision 9) —
// this import must stay dynamic, never hoisted to a static import above.
const GraphCanvas = lazy(() => import('../components/graph/GraphCanvas.js'))

export function HomePage() {
  const vaults = useVaults()
  useShellBreadcrumb([{ label: 'Graph' }])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {vaults.isPending ? (
        <GraphSkeleton />
      ) : vaults.isError ? (
        // Ordered before the `.length === 0` check on purpose: when the
        // vaults fetch fails, `vaults.data` is undefined, so
        // `vaults.data?.length === 0` is false and a chain that only tests
        // for that falls through to the graph branch — rendering a stale
        // or blank graph over a failed fetch. Unit 1b's review caught this
        // exact shape; `isError` has to be checked before `data` is ever read.
        <PanelState
          status="error"
          title="We couldn’t load your vaults."
          message={vaults.error.message}
          onRetry={() => vaults.refetch()}
          className="h-full"
        />
      ) : vaults.data.length === 0 ? (
        <VaultEmptyState />
      ) : (
        <>
          {/* A row of its own, not an overlay: the scope picker used to be
              painted over the canvas by the old shell, and the canvas padded
              itself to dodge it. */}
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
            <ScopePicker />
          </div>
          <div className="min-h-0 flex-1">
            <Suspense fallback={<GraphSkeleton />}>
              <GraphCanvas />
            </Suspense>
          </div>
        </>
      )}
    </div>
  )
}
