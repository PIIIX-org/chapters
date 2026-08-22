import { lazy, Suspense } from 'react'
import { AppShell } from '../components/shell/AppShell.js'
import { GraphSkeleton } from '../components/graph/GraphSkeleton.js'
import { VaultEmptyState } from '../components/vault/VaultEmptyState.js'
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
      ) : vaults.data?.length === 0 ? (
        <VaultEmptyState />
      ) : (
        <Suspense fallback={<GraphSkeleton />}>
          <GraphCanvas />
        </Suspense>
      )}
    </AppShell>
  )
}
