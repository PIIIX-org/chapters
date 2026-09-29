import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { GraphEdge, GraphNode } from '../../api/graph.js'
import { GraphPathfinder } from './GraphPathfinder.js'

const MOCK_NODES: GraphNode[] = [
  {
    id: 'n1',
    resourceType: 'note',
    resourceId: 'v1',
    path: 'concepts/auth.md',
    type: null,
    tags: [],
    timestamp: null,
    updatedAt: null,
    community: 1,
  },
  {
    id: 'n2',
    resourceType: 'note',
    resourceId: 'v1',
    path: 'concepts/session.md',
    type: null,
    tags: [],
    timestamp: null,
    updatedAt: null,
    community: 1,
  },
  {
    id: 'n3',
    resourceType: 'code',
    resourceId: 'r1',
    path: 'src/auth/session.ts',
    type: null,
    tags: [],
    timestamp: null,
    updatedAt: null,
    community: 1,
  },
  {
    id: 'n4',
    resourceType: 'note',
    resourceId: 'v1',
    path: 'isolated/island.md',
    type: null,
    tags: [],
    timestamp: null,
    updatedAt: null,
    community: 2,
  },
]

const MOCK_EDGES: GraphEdge[] = [
  { source: 'n1', target: 'n2', kind: 'extracted' },
  { source: 'n2', target: 'n3', kind: 'structural' },
]

describe('GraphPathfinder', () => {
  it('renders inputs and controls with zero a11y violations', async () => {
    const { container } = render(
      <MemoryRouter>
        <GraphPathfinder nodes={MOCK_NODES} edges={MOCK_EDGES} />
      </MemoryRouter>,
    )

    expect(screen.getByRole('combobox', { name: 'Start concept' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Target concept' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /swap start and target concepts/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /find shortest path/i })).toBeDisabled()

    await expectNoA11yViolations(container)
  })

  it('finds path, displays steps, and notifies onPathChange callback', async () => {
    const user = userEvent.setup()
    const onPathChange = vi.fn()

    const { container } = render(
      <MemoryRouter>
        <GraphPathfinder nodes={MOCK_NODES} edges={MOCK_EDGES} onPathChange={onPathChange} />
      </MemoryRouter>,
    )

    await user.selectOptions(screen.getByRole('combobox', { name: 'Start concept' }), 'n1')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Target concept' }), 'n3')

    const findButton = screen.getByRole('button', { name: /find shortest path/i })
    expect(findButton).toBeEnabled()
    await user.click(findButton)

    expect(screen.getByText('2 hops')).toBeInTheDocument()
    expect(screen.getByText('3 nodes traversed')).toBeInTheDocument()
    expect(screen.getByText('concepts/auth.md')).toBeInTheDocument()
    expect(screen.getByText('concepts/session.md')).toBeInTheDocument()
    expect(screen.getByText('src/auth/session.ts')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'concepts/auth.md' })).toHaveAttribute('href', '/vaults/v1/notes/concepts/auth.md')
    expect(screen.getByRole('link', { name: 'src/auth/session.ts' })).toHaveAttribute('href', '/repos/r1/files/src/auth/session.ts')

    expect(onPathChange).toHaveBeenCalledWith(
      expect.objectContaining({
        found: true,
        distance: 2,
      }),
    )

    await expectNoA11yViolations(container)
  })

  it('filters concept options via search input', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <GraphPathfinder nodes={MOCK_NODES} edges={MOCK_EDGES} />
      </MemoryRouter>,
    )

    const searchInput = screen.getByRole('searchbox', { name: 'Filter concepts' })
    await user.type(searchInput, 'session')

    const startSelect = screen.getByRole('combobox', { name: 'Start concept' })
    expect(startSelect).toHaveTextContent('concepts/session.md')
    expect(startSelect).toHaveTextContent('src/auth/session.ts')
    expect(startSelect).not.toHaveTextContent('isolated/island.md')
  })

  it('swaps source and target concepts and recalculates path', async () => {
    const user = userEvent.setup()
    const onPathChange = vi.fn()

    render(
      <MemoryRouter>
        <GraphPathfinder nodes={MOCK_NODES} edges={MOCK_EDGES} onPathChange={onPathChange} />
      </MemoryRouter>,
    )

    await user.selectOptions(screen.getByRole('combobox', { name: 'Start concept' }), 'n1')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Target concept' }), 'n2')
    await user.click(screen.getByRole('button', { name: /find shortest path/i }))

    expect(screen.getByText('1 hop')).toBeInTheDocument()

    const swapButton = screen.getByRole('button', { name: /swap start and target concepts/i })
    await user.click(swapButton)

    const startSelect = screen.getByRole('combobox', { name: 'Start concept' }) as HTMLSelectElement
    const targetSelect = screen.getByRole('combobox', { name: 'Target concept' }) as HTMLSelectElement
    expect(startSelect.value).toBe('n2')
    expect(targetSelect.value).toBe('n1')

    expect(onPathChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        found: true,
        distance: 1,
      }),
    )
  })

  it('shows empty state when no path connects the concepts', async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <GraphPathfinder nodes={MOCK_NODES} edges={MOCK_EDGES} />
      </MemoryRouter>,
    )

    await user.selectOptions(screen.getByRole('combobox', { name: 'Start concept' }), 'n1')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Target concept' }), 'n4')
    await user.click(screen.getByRole('button', { name: /find shortest path/i }))

    expect(
      screen.getByText(/no connecting path exists between these two concepts/i),
    ).toBeInTheDocument()
  })

  it('resets path search state when clicking reset', async () => {
    const user = userEvent.setup()
    const onPathChange = vi.fn()

    render(
      <MemoryRouter>
        <GraphPathfinder nodes={MOCK_NODES} edges={MOCK_EDGES} onPathChange={onPathChange} />
      </MemoryRouter>,
    )

    await user.selectOptions(screen.getByRole('combobox', { name: 'Start concept' }), 'n1')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Target concept' }), 'n2')
    await user.click(screen.getByRole('button', { name: /find shortest path/i }))

    expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /reset/i }))

    expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/1 hop/i)).not.toBeInTheDocument()
    expect(onPathChange).toHaveBeenLastCalledWith(null)
  })
})
