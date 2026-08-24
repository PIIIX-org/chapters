import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { useGraph } from '../../hooks/useGraph.js'
import { GraphFilters, graphFiltersFromSearchParams, type FilterableNode } from './GraphFilters.js'

// Options come from "the currently loaded graph", never a hardcoded list —
// this stands in for that graph's nodes.
const NODES: FilterableNode[] = [
  { type: 'okf/person', tags: ['friends'] },
  { type: 'okf/place', tags: ['friends', 'travel'] },
]

const AGGREGATED_GRAPH = { aggregated: true, nodes: [], edges: [], cappedGroups: [] }
const MEMBER_GRAPH = { nodes: [], edges: [], cappedGroups: [], memberTotal: 0 }

function stubFetch() {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('community=')) return Promise.resolve(mockJsonResponse(200, MEMBER_GRAPH))
    return Promise.resolve(mockJsonResponse(200, AGGREGATED_GRAPH))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// Reads the same URL, through the same router, that GraphFilters itself
// writes to — proves the URL is the source of truth, not component state.
function SearchParamsProbe() {
  const [params] = useSearchParams()
  return <div data-testid="params">{params.toString()}</div>
}

// Drives the real fetch exactly the way GraphCanvas/GraphOutline do:
// filters parsed from the URL, fed into useGraph. A panel that keeps
// filters in its own useState (never touching the URL) renders fine but
// this probe never observes a changed request — which is the point.
function FetchProbe({ community }: { community: number | null }) {
  const [searchParams] = useSearchParams()
  useGraph(community, graphFiltersFromSearchParams(searchParams))
  return null
}

function BackButton() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Go back
    </button>
  )
}

function renderFilters({ community = null as number | null, initialEntry = '/?vault=v1' } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <GraphFilters nodes={NODES} />
        <FetchProbe community={community} />
        <SearchParamsProbe />
        <BackButton />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// Tabs until the element with this role+name has focus — a real keyboard
// path through the tab order, never a hand-picked `.focus()` call.
async function tabToRole(
  user: ReturnType<typeof userEvent.setup>,
  role: Parameters<typeof screen.getByRole>[0],
  name: RegExp | string,
): Promise<HTMLElement> {
  for (let i = 0; i < 30; i++) {
    await user.tab()
    const active = document.activeElement
    if (active instanceof HTMLElement) {
      const match = screen.queryByRole(role, { name })
      if (match === active) return active
    }
  }
  throw new Error(`Tabbed 30 times without focusing ${String(role)} ${String(name)}`)
}

function lastFetchUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  return fetchMock.mock.calls.at(-1)?.[0] as string
}

describe('GraphFilters', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('clicking a type checkbox and entering a since-date changes the next graph request', async () => {
    const fetchMock = stubFetch()
    const user = userEvent.setup()
    renderFilters()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    fetchMock.mockClear()

    await user.click(screen.getByRole('checkbox', { name: 'okf/person' }))
    await user.click(screen.getByLabelText('Since'))
    await user.paste('2026-01-01')

    await waitFor(() => {
      const url = lastFetchUrl(fetchMock)
      expect(url).toContain('types=okf%2Fperson')
      expect(url).toContain('since=2026-01-01')
    })
  })

  it('keeps filters in the URL search params, and browser back restores the prior graph request', async () => {
    const fetchMock = stubFetch()
    const user = userEvent.setup()
    renderFilters()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())

    await user.click(screen.getByRole('checkbox', { name: 'okf/person' }))
    await waitFor(() => expect(screen.getByTestId('params').textContent).toBe('vault=v1&types=okf%2Fperson'))

    fetchMock.mockClear()
    await user.click(screen.getByRole('button', { name: 'Go back' }))

    await waitFor(() => expect(screen.getByTestId('params').textContent).toBe('vault=v1'))
    await waitFor(() => expect(lastFetchUrl(fetchMock)).not.toContain('types='))
  })

  it('applying a filter while a community is expanded keeps community=<n> in the request', async () => {
    const fetchMock = stubFetch()
    const user = userEvent.setup()
    renderFilters({ community: 3 })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    fetchMock.mockClear()

    await user.click(screen.getByRole('checkbox', { name: 'okf/person' }))

    await waitFor(() => {
      const url = lastFetchUrl(fetchMock)
      expect(url).toContain('community=3')
      expect(url).toContain('types=okf%2Fperson')
    })
  })

  it('"Clear filters" removes every filter param and then disappears; the control is absent when nothing is set', async () => {
    stubFetch()
    const user = userEvent.setup()
    renderFilters()

    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()

    await user.click(screen.getByRole('checkbox', { name: 'okf/person' }))
    await user.click(screen.getByLabelText('Since'))
    await user.paste('2026-01-01')

    expect(await screen.findByRole('button', { name: 'Clear filters' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))

    expect(screen.getByTestId('params').textContent).toBe('vault=v1')
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('shows the active filter count as text, not colour alone', async () => {
    stubFetch()
    const user = userEvent.setup()
    renderFilters()

    expect(screen.getByText('No filters active')).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'okf/person' }))
    expect(await screen.findByText('1 filter active')).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'okf/place' }))
    expect(await screen.findByText('2 filters active')).toBeInTheDocument()
  })

  it('is fully reachable and operable by keyboard alone — tab and space — with no pointer events', async () => {
    const fetchMock = stubFetch()
    const user = userEvent.setup()
    renderFilters()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())

    await tabToRole(user, 'checkbox', 'okf/person')
    await user.keyboard(' ')
    expect(screen.getByRole('checkbox', { name: 'okf/person' })).toBeChecked()
    await waitFor(() => expect(screen.getByTestId('params').textContent).toContain('types=okf%2Fperson'))

    await tabToRole(user, 'button', 'Clear filters')
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('params').textContent).toBe('vault=v1')
  })

  it('has no accessibility violations with no filters applied', async () => {
    stubFetch()
    const { container } = renderFilters()
    await expectNoA11yViolations(container)
  })

  it('still offers a checkbox for a selected value absent from the loaded nodes, so it can be turned off', async () => {
    stubFetch()
    const user = userEvent.setup()
    renderFilters({ initialEntry: '/?vault=v1&tags=engineering' })

    // Without the union fix, 'engineering' isn't in NODES' tags at all, so
    // this throws instead of finding a checked, removable checkbox.
    const engineering = await screen.findByRole('checkbox', { name: 'engineering' })
    expect(engineering).toBeChecked()

    // Regression check: the node-derived tags still render alongside it,
    // with no duplicate entry for a value that's both selected and
    // node-derived.
    expect(screen.getAllByRole('checkbox', { name: 'friends' })).toHaveLength(1)
    expect(screen.getByRole('checkbox', { name: 'travel' })).toBeInTheDocument()

    await user.click(engineering)
    await waitFor(() => expect(screen.getByTestId('params').textContent).toBe('vault=v1'))
  })

  it('has no accessibility violations with filters applied', async () => {
    stubFetch()
    const user = userEvent.setup()
    const { container } = renderFilters()

    await user.click(screen.getByRole('checkbox', { name: 'okf/person' }))
    await user.click(screen.getByLabelText('Since'))
    await user.paste('2026-01-01')
    await screen.findByRole('button', { name: 'Clear filters' })

    await expectNoA11yViolations(container)
  })
})
