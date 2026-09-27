import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { LocalGraphPanel } from './LocalGraphPanel.js'
import type { LocalGraphData } from '../../api/graph.js'

const MOCK_GRAPH: LocalGraphData = {
  center: {
    id: 'center-id',
    path: 'docs/architecture',
    name: 'architecture',
    title: 'Architecture Overview',
    type: 'docs',
    resourceType: 'note',
    resourceId: 'v1',
    isCenter: true,
    depth: 0,
  },
  nodes: [
    {
      id: 'center-id',
      path: 'docs/architecture',
      name: 'architecture',
      title: 'Architecture Overview',
      type: 'docs',
      resourceType: 'note',
      resourceId: 'v1',
      isCenter: true,
      depth: 0,
    },
    {
      id: 'neighbor-1',
      path: 'guides/data-flow',
      name: 'data-flow',
      title: 'Data Flow Guide',
      type: 'guides',
      resourceType: 'note',
      resourceId: 'v1',
      isCenter: false,
      depth: 1,
    },
    {
      id: 'neighbor-2',
      path: 'adr/001-crdt',
      name: '001-crdt',
      title: 'ADR 001 CRDT',
      type: 'adr',
      resourceType: 'note',
      resourceId: 'v1',
      isCenter: false,
      depth: 1,
    },
  ],
  edges: [
    { source: 'center-id', target: 'neighbor-1', kind: 'extracted' },
    { source: 'neighbor-2', target: 'center-id', kind: 'extracted' },
  ],
}

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

function stubFetch(response: (url: string) => Response) {
  const fetchMock = vi.fn((url: RequestInfo | URL) =>
    Promise.resolve(response(typeof url === 'string' ? url : url.toString())),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('LocalGraphPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders loading state initially', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderWithClient(<LocalGraphPanel vaultId="v1" path="docs/architecture" />)

    expect(screen.getByText('Loading local graph…')).toBeTruthy()
  })

  it('renders error state on fetch failure', async () => {
    stubFetch(() => mockJsonResponse(500, { error: 'Failed to load graph' }))
    renderWithClient(<LocalGraphPanel vaultId="v1" path="docs/architecture" />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Failed to load graph')
  })

  it('renders empty state when center note has no connections', async () => {
    stubFetch(() =>
      mockJsonResponse(200, {
        center: MOCK_GRAPH.center,
        nodes: [MOCK_GRAPH.center],
        edges: [],
      }),
    )
    const { container } = renderWithClient(
      <LocalGraphPanel vaultId="v1" path="docs/architecture" />,
    )

    expect(await screen.findByText(/No local connections yet/)).toBeTruthy()
    expect(screen.getByText('[[wikilinks]]')).toBeTruthy()

    await expectNoA11yViolations(container)
  })

  it('renders SVG graph, connections list, and relationship pills', async () => {
    stubFetch(() => mockJsonResponse(200, MOCK_GRAPH))
    const { container } = renderWithClient(
      <LocalGraphPanel vaultId="v1" path="docs/architecture" />,
    )

    // Wait for nodes to load
    expect(await screen.findByText('Connections (2)')).toBeTruthy()

    // SVG elements
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()

    // Relations in list
    const list = screen.getByRole('list', { name: 'Connected notes' })
    expect(within(list).getByText('Data Flow Guide')).toBeInTheDocument()
    expect(within(list).getByText('ADR 001 CRDT')).toBeInTheDocument()
    expect(within(list).getByText('Outgoing')).toBeInTheDocument()
    expect(within(list).getByText('Backlink')).toBeInTheDocument()

    // Depth toggle default
    const hop1 = screen.getByRole('button', { name: '1 hop' })
    const hop2 = screen.getByRole('button', { name: '2 hops' })
    expect(hop1).toHaveAttribute('aria-pressed', 'true')
    expect(hop2).toHaveAttribute('aria-pressed', 'false')

    await expectNoA11yViolations(container)
  })

  it('toggles depth between 1 and 2 hops', async () => {
    stubFetch((url) => {
      if (url.includes('depth=2')) {
        return mockJsonResponse(200, {
          ...MOCK_GRAPH,
          nodes: [
            ...MOCK_GRAPH.nodes,
            {
              id: 'neighbor-3',
              path: 'specs/sync',
              name: 'sync',
              title: 'Sync Spec',
              type: 'specs',
              resourceType: 'note',
              resourceId: 'v1',
              isCenter: false,
              depth: 2,
            },
          ],
        })
      }
      return mockJsonResponse(200, MOCK_GRAPH)
    })

    const user = userEvent.setup()
    renderWithClient(<LocalGraphPanel vaultId="v1" path="docs/architecture" />)

    expect(await screen.findByText('Connections (2)')).toBeTruthy()

    const hop2 = screen.getByRole('button', { name: '2 hops' })
    await user.click(hop2)

    expect(hop2).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByText('Connections (3)')).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Connected notes' })
    expect(within(list).getByText('Sync Spec')).toBeInTheDocument()
  })

  it('allows hover tooltip and keyboard navigation via connection list', async () => {
    stubFetch(() => mockJsonResponse(200, MOCK_GRAPH))
    const { container } = renderWithClient(<LocalGraphPanel vaultId="v1" path="docs/architecture" />)

    expect(await screen.findByText('Connections (2)')).toBeTruthy()

    // Hover over an SVG node group reveals the tooltip
    const nodeGroups = container.querySelectorAll('svg g')
    expect(nodeGroups.length).toBe(3) // center + 2 neighbors

    fireEvent.mouseEnter(nodeGroups[1]!)
    expect(screen.getByText('(guides/data-flow)')).toBeInTheDocument()

    fireEvent.mouseLeave(nodeGroups[1]!)
    expect(screen.queryByText('(guides/data-flow)')).not.toBeInTheDocument()

    // Navigation links in the connection list are accessible
    const links = screen.getAllByRole('link')
    expect(links.length).toBe(2)
    expect(links[0]!.getAttribute('href')).toBe('/vaults/v1/notes/guides/data-flow')
    expect(links[1]!.getAttribute('href')).toBe('/vaults/v1/notes/adr/001-crdt')
  })
})
