import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../lib/api'
import { RequireAuth } from './RequireAuth'

function renderWithRouter(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        element: <RequireAuth />,
        children: [{ path: '/', element: <div>Protected content</div> }],
      },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: [initialPath] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('RequireAuth', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the protected route when the session resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { id: 'u1', email: 'a@b.com', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      ),
    )

    renderWithRouter('/')

    await waitFor(() => expect(screen.getByText('Protected content')).toBeInTheDocument())
  })

  it('redirects to /login when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'unauthorized' })))

    renderWithRouter('/')

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument())
  })
})
