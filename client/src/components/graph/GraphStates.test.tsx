import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { useGraph } from '../../hooks/useGraph.js'
import type { CommunityGraph, VaultGraph } from '../../api/graph.js'
import { CappedGroupsNotice, GraphEmptyState, GraphErrorState, TruncationNotice } from './GraphStates.js'

function isCommunityGraph(data: VaultGraph | CommunityGraph): data is CommunityGraph {
  return 'aggregated' in data
}

// Drives a real useGraph query (same hook GraphCanvas uses) so the retry
// button below calls the query's own refetch, not a decoy piece of local
// state — the exact "test that cannot fail" shape this project has shipped
// before (an Escape handler bound to the wrong element, passing only
// because the test fired the event directly on that element).
function GraphQueryHarness() {
  const graph = useGraph(null, {})
  if (graph.isPending) return null
  if (graph.isError) return <GraphErrorState message={graph.error.message} onRetry={() => graph.refetch()} />
  if (!graph.data || graph.data.nodes.length === 0) return <GraphEmptyState createNoteHref="/vaults/v1" />
  return (
    <>
      <CappedGroupsNotice groups={graph.data.cappedGroups} />
      {!isCommunityGraph(graph.data) && (
        <TruncationNotice shown={graph.data.nodes.length} total={graph.data.memberTotal ?? graph.data.nodes.length} />
      )}
    </>
  )
}

function renderHarness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GraphQueryHarness />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function memberNodes(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    resourceType: 'note',
    resourceId: `r${i}`,
    path: `n${i}.md`,
    type: null,
    tags: [],
    timestamp: null,
    updatedAt: null,
    community: 0,
  }))
}

describe('GraphStates', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a failed graph request shows the error copy with a retry that actually refetches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(500, { error: 'Assembly timed out' }))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    renderHarness()

    expect(await screen.findByText("We couldn’t load the graph.")).toBeInTheDocument()
    expect(screen.getByText('Assembly timed out')).toBeInTheDocument()
    const callsBefore = fetchMock.mock.calls.length

    // A button that only sets local state (never calling refetch) would
    // leave the fetch count unchanged here.
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('a successful empty graph shows the empty copy, never the error copy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { nodes: [], edges: [], cappedGroups: [] })))

    renderHarness()

    expect(await screen.findByText('Nothing to draw yet')).toBeInTheDocument()
    expect(screen.queryByText("We couldn’t load the graph.")).toBeNull()
  })

  it('names a capped group in a non-blocking notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, {
          nodes: [{ id: 'c0', community: 0, size: 1, noteCount: 1, codeCount: 0, lastActivity: null }],
          edges: [],
          cappedGroups: ['tag:project-x'],
        }),
      ),
    )

    renderHarness()

    expect(await screen.findByText(/tag:project-x/)).toBeInTheDocument()
  })

  it('states the drill-down cap instead of silently truncating', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { nodes: memberNodes(2500), edges: [], cappedGroups: [], memberTotal: 9140 }),
      ),
    )

    renderHarness()

    // A hardcoded cap number, or reading `nodes.length` for the total
    // instead of `memberTotal`, produces a different string and fails this.
    expect(await screen.findByText('Showing 2,500 of 9,140 notes in this community')).toBeInTheDocument()
  })

  it('has no accessibility violations in the error branch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(500, { error: 'boom' })))
    const { container } = renderHarness()
    await screen.findByText("We couldn’t load the graph.")
    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations in the empty branch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { nodes: [], edges: [], cappedGroups: [] })))
    const { container } = renderHarness()
    await screen.findByText('Nothing to draw yet')
    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations with a capped-groups notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, {
          nodes: [{ id: 'c0', community: 0, size: 1, noteCount: 1, codeCount: 0, lastActivity: null }],
          edges: [],
          cappedGroups: ['tag:project-x'],
        }),
      ),
    )
    const { container } = renderHarness()
    await screen.findByText(/tag:project-x/)
    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations with a truncation notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(200, { nodes: memberNodes(5), edges: [], cappedGroups: [], memberTotal: 20 })),
    )
    const { container } = renderHarness()
    await screen.findByText(/Showing 5 of 20/)
    await expectNoA11yViolations(container)
  })
})
