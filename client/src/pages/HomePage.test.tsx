import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../lib/api'
import { HomePage } from './HomePage'

function renderWithRouter() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/', element: <HomePage /> },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: ['/'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function stubFetch(vaults: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, vaults))
      if (url === '/api/logout') return Promise.resolve(mockJsonResponse(200, { status: 'logged_out' }))
      return Promise.resolve(
        mockJsonResponse(200, { id: 'u1', email: 'taha@piiix.org', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      )
    }),
  )
}

describe('HomePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("greets the logged-in user's email", async () => {
    stubFetch([])
    renderWithRouter()

    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())
  })

  it('lists accessible vaults, linking to each one', async () => {
    stubFetch([{ id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' }])
    renderWithRouter()

    const link = await screen.findByRole('link', { name: 'Engineering' })
    expect(link).toHaveAttribute('href', '/vaults/v1')
  })

  it('shows an empty-state message when there are no vaults', async () => {
    stubFetch([])
    renderWithRouter()

    await waitFor(() => expect(screen.getByText('No vaults yet.')).toBeInTheDocument())
  })

  it('logs out and navigates to /login', async () => {
    stubFetch([])
    renderWithRouter()
    const user = userEvent.setup()

    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Log out' }))

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument())
  })
})
