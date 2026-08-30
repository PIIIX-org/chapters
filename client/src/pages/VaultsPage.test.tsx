import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { mockJsonResponse } from '../lib/api'
import { expectNoA11yViolations } from '../test/axe'
import { VaultsPage } from './VaultsPage'

const VAULTS = [
  { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
  { id: 'v2', name: 'Recipes', ownerId: 'u2', mergeable: false, access: 'read' },
]

function stubFetch(vaults: unknown = VAULTS, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(status, vaults))
      if (url === '/api/vaults/trash') return Promise.resolve(mockJsonResponse(200, []))
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    }),
  )
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/vaults']}>
        <VaultsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('VaultsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists every reachable vault as a link, with owner actions only where owned', async () => {
    stubFetch()
    renderPage()

    expect(await screen.findByRole('link', { name: 'Engineering' })).toHaveAttribute('href', '/vaults/v1')
    expect(screen.getByRole('link', { name: 'Recipes' })).toHaveAttribute('href', '/vaults/v2')
    expect(screen.getByText('Owner')).toBeInTheDocument()
    expect(screen.getByText('Read only')).toBeInTheDocument()
    // Rename/delete exist for the owned vault and for nothing else.
    expect(screen.getByRole('button', { name: 'Rename Engineering' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rename Recipes' })).toBeNull()
  })

  it('shows the empty state, and an error state with retry, before ever reading data', async () => {
    stubFetch([])
    const { unmount } = renderPage()
    expect(await screen.findByText('No vaults yet')).toBeInTheDocument()
    unmount()

    stubFetch({ error: 'boom' }, 500)
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t load your vaults.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    stubFetch()
    const { container } = renderPage()
    await screen.findByRole('link', { name: 'Engineering' })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/vaults/trash', expect.anything()))
    await expectNoA11yViolations(container)
  })
})
