import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { AdminTeam, AdminUser, AdminVault } from '../../api/admin.js'
import { VaultOversight } from './VaultOversight.js'

const VAULTS: AdminVault[] = [
  {
    id: 'v1',
    name: 'Field notes',
    ownerEmail: 'owner@example.com',
    mergeable: true,
    noteCount: 12,
    shareCount: 2,
    lastActivity: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'v2',
    name: 'Untouched',
    ownerEmail: 'owner@example.com',
    mergeable: false,
    noteCount: 0,
    shareCount: 0,
    lastActivity: null,
  },
]

// The owner, one eligible replacement, and one deactivated account the server
// would reject — a roster of only-eligible users would let a missing filter pass.
const USERS: AdminUser[] = [
  {
    id: 'owner',
    email: 'owner@example.com',
    status: 'active',
    role: 'member',
    emailVerifiedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  { id: 'u2', email: 'ada@example.com', status: 'active', role: 'member', emailVerifiedAt: null, createdAt: '2026-08-01T00:00:00.000Z' },
  { id: 'u3', email: 'gone@example.com', status: 'deactivated', role: 'member', emailVerifiedAt: null, createdAt: '2026-08-01T00:00:00.000Z' },
]

const TEAMS: AdminTeam[] = [{ id: 't1', name: 'Design', memberCount: 4 }]

function fetchMock() {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(mockJsonResponse(200, { ownerId: 'u2' }))
    if (url === '/api/admin/vaults') return Promise.resolve(mockJsonResponse(200, VAULTS))
    if (url === '/api/admin/users') return Promise.resolve(mockJsonResponse(200, USERS))
    if (url === '/api/admin/teams') return Promise.resolve(mockJsonResponse(200, TEAMS))
    return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
  })
}

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('VaultOversight', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows structural counts for both vaults, including the idle one', async () => {
    vi.stubGlobal('fetch', fetchMock())
    const { container } = renderWithClient(<VaultOversight />)

    const idleRow = (await screen.findByText('Untouched')).closest('tr')!
    // A vault nobody has written to still has a row — dropping it would hide
    // exactly the vault an admin is most likely looking for.
    expect(idleRow.textContent).toContain('No activity yet')
    expect(within((await screen.findByText('Field notes')).closest('tr')!).getByText('12')).toBeInTheDocument()
    expect(screen.getByText('Design')).toBeInTheDocument()

    await expectNoA11yViolations(container)
  })

  it('offers only active accounts other than the current owner as the new owner', async () => {
    vi.stubGlobal('fetch', fetchMock())
    renderWithClient(<VaultOversight />)

    await userEvent.click(await screen.findByRole('button', { name: 'Reassign ownership of Field notes' }))
    const select = screen.getByLabelText(/New owner for Field notes/)
    const options = within(select).getAllByRole('option').map((o) => o.textContent)

    expect(options).toEqual(['ada@example.com'])
    expect(options).not.toContain('owner@example.com')
    expect(options).not.toContain('gone@example.com')
  })

  it('states what the old owner loses, then POSTs the transfer', async () => {
    const fetch = fetchMock()
    vi.stubGlobal('fetch', fetch)
    renderWithClient(<VaultOversight />)

    await userEvent.click(await screen.findByRole('button', { name: 'Reassign ownership of Field notes' }))
    expect(screen.getByText(/keeps no special access/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/vaults/v1/transfer-owner', expect.anything())

    await userEvent.click(screen.getByRole('button', { name: 'Reassign' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/vaults/v1/transfer-owner',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ newOwnerId: 'u2' }) }),
      ),
    )
  })
})
