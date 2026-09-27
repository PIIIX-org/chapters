import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { AdminUser } from '../../api/admin.js'
import { UserRoster } from './UserRoster.js'

// Four shapes, because each one gates a different control: the signed-in
// admin (no actions on self), another admin (no Promote), a plain active
// member (both actions), and someone already deactivated (neither).
const ME: AdminUser = {
  id: 'me',
  email: 'me@example.com',
  status: 'active',
  role: 'admin',
  emailVerifiedAt: '2026-08-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
}
const USERS: AdminUser[] = [
  ME,
  { ...ME, id: 'a2', email: 'other-admin@example.com' },
  { ...ME, id: 'm1', email: 'member@example.com', role: 'member' },
  { ...ME, id: 'd1', email: 'gone@example.com', role: 'member', status: 'deactivated' },
]

function fetchMock() {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(mockJsonResponse(200, { status: 'deactivated' }))
    if (url === '/api/me') return Promise.resolve(mockJsonResponse(200, ME))
    return Promise.resolve(mockJsonResponse(200, USERS))
  })
}

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function rowFor(email: string): HTMLElement {
  return screen.getByText(email).closest('tr')!
}

describe('UserRoster', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers each action only where it applies', async () => {
    vi.stubGlobal('fetch', fetchMock())
    const { container } = renderWithClient(<UserRoster />)

    await screen.findByText('member@example.com')

    // A plain active member: both levers.
    expect(within(rowFor('member@example.com')).getByRole('button', { name: /^Promote/ })).toBeInTheDocument()
    expect(within(rowFor('member@example.com')).getByRole('button', { name: /^Deactivate/ })).toBeInTheDocument()

    // Already an admin: demote is available, but not promote.
    expect(within(rowFor('other-admin@example.com')).queryByRole('button', { name: /^Promote/ })).toBeNull()
    expect(within(rowFor('other-admin@example.com')).getByRole('button', { name: /^Demote/ })).toBeInTheDocument()
    expect(within(rowFor('other-admin@example.com')).getByRole('button', { name: /^Deactivate/ })).toBeInTheDocument()

    // Yourself: deactivating or demoting would sign you out and, alone, lock the instance
    // out of its own admin area.
    await waitFor(() =>
      expect(within(rowFor('me@example.com')).queryByRole('button', { name: /^Deactivate/ })).toBeNull(),
    )
    expect(within(rowFor('me@example.com')).queryByRole('button', { name: /^Demote/ })).toBeNull()
    expect(within(rowFor('me@example.com')).getByText('This is you')).toBeInTheDocument()

    // Already deactivated: reactivation is available, but not deactivate or demote.
    expect(within(rowFor('gone@example.com')).queryByRole('button', { name: /^Deactivate/ })).toBeNull()
    expect(within(rowFor('gone@example.com')).queryByRole('button', { name: /^Demote/ })).toBeNull()
    expect(within(rowFor('gone@example.com')).getByRole('button', { name: /^Reactivate/ })).toBeInTheDocument()

    // Role selector is present for active accounts other than self.
    expect(
      within(rowFor('member@example.com')).getByRole('combobox', {
        name: 'Change role for member@example.com',
      }),
    ).toBeInTheDocument()

    await expectNoA11yViolations(container)
  })

  it('states the consequence before demoting, and only acts on confirm', async () => {
    const fetch = fetchMock()
    vi.stubGlobal('fetch', fetch)
    renderWithClient(<UserRoster />)

    await screen.findByText('other-admin@example.com')
    await userEvent.click(
      within(rowFor('other-admin@example.com')).getByRole('button', {
        name: 'Demote other-admin@example.com',
      }),
    )

    expect(screen.getByText(/will lose administrative privileges/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/users/a2/demote', expect.anything())

    await userEvent.click(screen.getByRole('button', { name: 'Demote' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/users/a2/demote',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  it('allows changing role via role selector', async () => {
    const fetch = fetchMock()
    vi.stubGlobal('fetch', fetch)
    renderWithClient(<UserRoster />)

    await screen.findByText('member@example.com')
    const roleSelect = within(rowFor('member@example.com')).getByRole('combobox', {
      name: 'Change role for member@example.com',
    })

    await userEvent.selectOptions(roleSelect, 'moderator')
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/users/m1/role',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ role: 'moderator' }),
        }),
      ),
    )
  })

  it('states the consequence before deactivating, and only acts on confirm', async () => {
    const fetch = fetchMock()
    vi.stubGlobal('fetch', fetch)
    renderWithClient(<UserRoster />)

    await screen.findByText('member@example.com')
    await userEvent.click(
      within(rowFor('member@example.com')).getByRole('button', { name: 'Deactivate member@example.com' }),
    )

    // The design rule: the consequence in plain language, not "Are you sure?".
    expect(screen.getByText(/dropped from every team/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/users/m1/deactivate', expect.anything())

    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/users/m1/deactivate',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  it('cancelling leaves the account alone', async () => {
    const fetch = fetchMock()
    vi.stubGlobal('fetch', fetch)
    renderWithClient(<UserRoster />)

    await screen.findByText('member@example.com')
    await userEvent.click(
      within(rowFor('member@example.com')).getByRole('button', { name: 'Deactivate member@example.com' }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText(/dropped from every team/)).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/users/m1/deactivate', expect.anything())
  })

  it('states the consequence before reactivating, and only acts on confirm', async () => {
    const fetch = fetchMock()
    vi.stubGlobal('fetch', fetch)
    renderWithClient(<UserRoster />)

    await screen.findByText('gone@example.com')
    await userEvent.click(
      within(rowFor('gone@example.com')).getByRole('button', { name: 'Reactivate gone@example.com' }),
    )

    expect(screen.getByText(/restored to active status/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/users/d1/reactivate', expect.anything())

    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/users/d1/reactivate',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })
})
