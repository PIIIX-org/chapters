import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { VaultLayout } from './VaultLayout'

function renderLayout() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/vaults/:vaultId',
        element: <VaultLayout />,
        children: [{ index: true, element: <div>Empty state</div> }],
      },
    ],
    { initialEntries: ['/vaults/v1'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('VaultLayout', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the file tree in the sidebar and the outlet content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/api/vaults') {
          return Promise.resolve(
            mockJsonResponse(200, [{ id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' }]),
          )
        }
        return Promise.resolve(
          mockJsonResponse(200, {
            people: [
              { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' },
            ],
          }),
        )
      }),
    )

    renderLayout()

    await waitFor(() => expect(screen.getByRole('link', { name: 'jane' })).toBeInTheDocument())
    expect(screen.getByText('Empty state')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Vaults' })).toHaveAttribute('href', '/')
  })
})
