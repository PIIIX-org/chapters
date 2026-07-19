// @vitest-environment happy-dom
//
// react-router's data router builds a native `Request` (Node's undici) for every
// client-side navigation, even without loaders. jsdom overrides global
// AbortController/AbortSignal with its own (non-undici-compatible) versions but
// doesn't provide Request/fetch, so undici's Request rejects the signal:
// https://github.com/vitest-dev/vitest/issues/8374
// happy-dom ships a matching fetch/Request/AbortController set, so this file
// (and App.test.tsx, which also exercises <Navigate>) run under it instead.
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
