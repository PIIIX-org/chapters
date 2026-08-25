import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { mockJsonResponse } from '../lib/api.js'
import { expectNoA11yViolations } from '../test/axe.js'
import { AdminPage } from './AdminPage.js'

const ADMIN = {
  id: 'me',
  email: 'admin@example.com',
  status: 'active',
  role: 'admin',
  createdAt: '2026-08-01T00:00:00.000Z',
}
const MEMBER = { ...ADMIN, role: 'member' }

function fetchMock(session: typeof ADMIN) {
  return vi.fn().mockImplementation((url: string) => {
    if (url === '/api/me') return Promise.resolve(mockJsonResponse(200, session))
    if (url.startsWith('/api/admin/users')) return Promise.resolve(mockJsonResponse(200, []))
    if (url.startsWith('/api/admin/stats')) {
      return Promise.resolve(
        mockJsonResponse(200, {
          usersByStatus: [],
          vaults: 0,
          teams: 0,
          notes: 0,
          storageBytes: 0,
          activeMcpConnections: 0,
        }),
      )
    }
    return Promise.resolve(mockJsonResponse(200, []))
  })
}

function renderPage(session: typeof ADMIN) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('AdminPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens on the approval queue — the reason this area exists', async () => {
    vi.stubGlobal('fetch', fetchMock(ADMIN))
    const { container } = renderPage(ADMIN)

    expect(await screen.findByText(/Nobody is waiting/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approvals' })).toHaveAttribute('aria-current', 'page')

    await expectNoA11yViolations(container)
  })

  it('tells a member this is not their area, and asks the server for nothing', async () => {
    const fetch = fetchMock(MEMBER)
    vi.stubGlobal('fetch', fetch)
    renderPage(MEMBER)

    expect(await screen.findByText('This area is for admins.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approvals' })).toBeNull()
    // Six instance-wide 403s would be the alternative, and none of them would
    // tell the person what happened.
    await waitFor(() => {
      const calls = fetch.mock.calls.map((c) => c[0] as string)
      expect(calls.some((url) => url.startsWith('/api/admin/'))).toBe(false)
    })
  })

  it('loads a section only once it is opened', async () => {
    const fetch = fetchMock(ADMIN)
    vi.stubGlobal('fetch', fetch)
    renderPage(ADMIN)

    await screen.findByText(/Nobody is waiting/)
    const before = fetch.mock.calls.map((c) => c[0] as string)
    expect(before).not.toContain('/api/admin/shares')

    await userEvent.click(screen.getByRole('button', { name: 'Access' }))
    await waitFor(() =>
      expect(fetch.mock.calls.map((c) => c[0] as string)).toContain('/api/admin/shares'),
    )
    expect(screen.getByRole('button', { name: 'Access' })).toHaveAttribute('aria-current', 'page')
  })
})
