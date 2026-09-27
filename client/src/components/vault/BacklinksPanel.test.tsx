import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { BacklinksPanel } from './BacklinksPanel.js'
import type { Backlink } from '../../api/notes.js'

const BACKLINKS: Backlink[] = [
  {
    id: 'note-1',
    path: 'guides/overview',
    type: 'guides',
    name: 'overview',
    title: 'Overview Guide',
    updatedAt: '2026-08-20T14:30:00.000Z',
  },
  {
    id: 'note-2',
    path: 'tasks/todo',
    type: 'tasks',
    name: 'todo',
    title: null,
    updatedAt: '2026-08-19T10:00:00.000Z',
  },
]

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response()))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('BacklinksPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders loading state initially', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderWithClient(<BacklinksPanel vaultId="v1" path="docs/architecture" />)

    expect(screen.getByText('Loading backlinks…')).toBeTruthy()
  })

  it('renders error state on fetch failure', async () => {
    stubFetch(() => mockJsonResponse(500, { error: 'Internal server error' }))
    renderWithClient(<BacklinksPanel vaultId="v1" path="docs/architecture" />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Internal server error')
  })

  it('renders helpful empty state when no notes link to this note', async () => {
    stubFetch(() => mockJsonResponse(200, []))
    const { container } = renderWithClient(<BacklinksPanel vaultId="v1" path="docs/architecture" />)

    expect(await screen.findByText(/No notes link here yet/)).toBeTruthy()
    expect(screen.getByText('[[docs/architecture]]')).toBeTruthy()

    await expectNoA11yViolations(container)
  })

  it('renders list of backlinks with titles, types, and navigation links', async () => {
    stubFetch(() => mockJsonResponse(200, BACKLINKS))
    const { container } = renderWithClient(<BacklinksPanel vaultId="v1" path="docs/architecture" />)

    expect(await screen.findByText('Overview Guide')).toBeTruthy()
    // Falls back to name when title is null
    expect(screen.getByText('todo')).toBeTruthy()

    // Type pills
    expect(screen.getByText('guides')).toBeTruthy()
    expect(screen.getByText('tasks')).toBeTruthy()

    // Paths
    expect(screen.getByText('guides/overview')).toBeTruthy()
    expect(screen.getByText('tasks/todo')).toBeTruthy()

    // Links to target note view
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links[0]!.getAttribute('href')).toBe('/vaults/v1/notes/guides/overview')
    expect(links[1]!.getAttribute('href')).toBe('/vaults/v1/notes/tasks/todo')

    await expectNoA11yViolations(container)
  })
})
