import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { AppShell } from './AppShell'

// Two distinctly named vaults on purpose: a one-vault fixture would let a
// picker that always selects the first entry pass.
const VAULTS = [
  { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
  { id: 'v2', name: 'Recipes', ownerId: 'u1', mergeable: true, access: 'owner' },
]

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, VAULTS))
      if (url === '/api/logout') return Promise.resolve(mockJsonResponse(200, { status: 'logged_out' }))
      if (url.startsWith('/api/notifications')) return Promise.resolve(mockJsonResponse(200, []))
      return Promise.resolve(
        mockJsonResponse(200, { id: 'u1', email: 'taha@piiix.org', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      )
    }),
  )
}

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <AppShell>
            <div data-testid="canvas" />
          </AppShell>
        ),
      },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: ['/'] },
  )
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('AppShell', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the canvas child and the scope picker trigger', async () => {
    stubFetch()
    renderShell()

    expect(screen.getByTestId('canvas')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'All vaults' })).toBeInTheDocument()
  })

  it('shows the session email and logs out via /api/logout, landing on /login', async () => {
    stubFetch()
    renderShell()
    const user = userEvent.setup()

    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Log out' }))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/logout', expect.objectContaining({ method: 'POST' })),
    )
    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument())
  })

  it('renders the notification bell inside the notifications slot', async () => {
    stubFetch()
    const { container } = renderShell()
    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())

    const slot = container.querySelector('[data-slot="notifications"]')
    expect(slot).toBeInTheDocument()
    expect(slot?.querySelector('button[aria-haspopup="dialog"]')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    stubFetch()
    const { container } = renderShell()
    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())

    await expectNoA11yViolations(container)
  })

  it('never uses the accent token for ordinary chrome (authorship colour is reserved)', async () => {
    stubFetch()
    const { container } = renderShell()
    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())

    const offenders = Array.from(container.querySelectorAll('*')).filter((el) =>
      Array.from(el.classList).some((c) => c === 'bg-accent' || c.startsWith('hover:bg-accent')),
    )
    expect(offenders).toHaveLength(0)
  })
})
