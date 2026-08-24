import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { VaultEmptyState } from './VaultEmptyState'

function renderEmptyState() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/', element: <VaultEmptyState /> },
      { path: '/vaults/:vaultId', element: <div>vault v1 loaded</div> },
    ],
    { initialEntries: ['/'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('VaultEmptyState', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the heading and the create-vault form', () => {
    vi.stubGlobal('fetch', vi.fn())
    renderEmptyState()

    expect(screen.getByRole('heading', { name: 'Your graph is empty' })).toBeInTheDocument()
    expect(screen.getByLabelText('Vault name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create vault/i })).toBeInTheDocument()
  })

  it('navigates to the new vault after a successful create', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(201, { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' }),
      ),
    )
    renderEmptyState()

    fireEvent.change(screen.getByLabelText('Vault name'), { target: { value: 'Engineering' } })
    fireEvent.click(screen.getByRole('button', { name: /create vault/i }))

    await waitFor(() => expect(screen.getByText('vault v1 loaded')).toBeInTheDocument())
  })

  it('never uses the teal AI-authorship accent classes', () => {
    vi.stubGlobal('fetch', vi.fn())
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <VaultEmptyState />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(container.querySelector('.bg-accent, .hover\\:bg-accent')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <VaultEmptyState />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await expectNoA11yViolations(container)
  })
})
