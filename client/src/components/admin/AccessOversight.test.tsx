import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { AdminMcpConnection, AdminShare, AdminTeam, AdminUser, AdminVault } from '../../api/admin.js'
import { AccessOversight } from './AccessOversight.js'

const VAULTS: AdminVault[] = [
  {
    id: 'v1',
    name: 'Field notes',
    ownerEmail: 'owner@example.com',
    mergeable: false,
    noteCount: 3,
    shareCount: 2,
    lastActivity: '2026-08-01T00:00:00.000Z',
  },
]
const USERS: AdminUser[] = [
  {
    id: 'u1',
    email: 'ada@example.com',
    status: 'active',
    role: 'member',
    emailVerifiedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
]
const TEAMS: AdminTeam[] = [{ id: 't1', name: 'Design', memberCount: 2 }]

// Three shares: one to a user, one to a team, and one pointing at a grantee
// that no longer exists. The third is the one that catches a join which
// silently renders a blank cell for a live grant.
const SHARES: AdminShare[] = [
  {
    id: 's1',
    vaultId: 'v1',
    granteeType: 'user',
    granteeId: 'u1',
    permission: 'edit',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 's2',
    vaultId: 'v1',
    granteeType: 'team',
    granteeId: 't1',
    permission: 'read',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 's3',
    vaultId: 'v1',
    granteeType: 'user',
    granteeId: 'ghost',
    permission: 'read',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
]

// One live, one already revoked — a uniform fixture would let a table that
// always renders the Revoke button pass.
const CONNECTIONS: AdminMcpConnection[] = [
  {
    id: 'c1',
    name: 'laptop agent',
    scope: 'account',
    userEmail: 'ada@example.com',
    vaultId: null,
    repositoryId: null,
    lastUsedAt: '2026-08-04T09:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'c2',
    name: 'leaked token',
    scope: 'vault',
    userEmail: 'owner@example.com',
    vaultId: 'v1',
    repositoryId: null,
    lastUsedAt: null,
    revokedAt: '2026-08-05T09:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
]

function fetchMock() {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE' || init?.method === 'POST') {
      return Promise.resolve(mockJsonResponse(200, { status: 'revoked' }))
    }
    if (url === '/api/admin/shares') return Promise.resolve(mockJsonResponse(200, SHARES))
    if (url === '/api/admin/vaults') return Promise.resolve(mockJsonResponse(200, VAULTS))
    if (url === '/api/admin/users') return Promise.resolve(mockJsonResponse(200, USERS))
    if (url === '/api/admin/teams') return Promise.resolve(mockJsonResponse(200, TEAMS))
    if (url === '/api/admin/mcp-connections') return Promise.resolve(mockJsonResponse(200, CONNECTIONS))
    return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
  })
}

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('AccessOversight', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names every grantee, including one whose account is gone, and never prints an id', async () => {
    vi.stubGlobal('fetch', fetchMock())
    const { container } = renderWithClient(<AccessOversight />)

    // Scoped to the shares table: ada@example.com also owns an MCP
    // connection, so an unscoped query would pass on the wrong table.
    const sharesTable = within(await screen.findByRole('table', { name: /vault share/i }))
    expect(sharesTable.getByText('ada@example.com')).toBeInTheDocument()
    expect(sharesTable.getByText('Design')).toBeInTheDocument()
    expect(sharesTable.getByText('user no longer on this instance')).toBeInTheDocument()

    // The whole point of joining client-side: no raw identifiers on screen.
    expect(container.textContent).not.toContain('ghost')
    expect(container.textContent).not.toContain('s1')

    await expectNoA11yViolations(container)
  })

  it('revoking a share DELETEs that share and states who loses what first', async () => {
    const fetch = fetchMock()
    vi.stubGlobal('fetch', fetch)
    renderWithClient(<AccessOversight />)

    await userEvent.click(
      await screen.findByRole('button', { name: "Revoke ada@example.com's access to Field notes" }),
    )
    expect(screen.getByText(/loses access to "Field notes" on their very next request/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/shares/s1', expect.anything())

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/shares/s1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    )
  })

  it('offers revoke on the live connection only, and shows the dead one as already revoked', async () => {
    const fetch = fetchMock()
    vi.stubGlobal('fetch', fetch)
    renderWithClient(<AccessOversight />)

    const liveRow = (await screen.findByText('laptop agent')).closest('tr')!
    const deadRow = screen.getByText('leaked token').closest('tr')!

    expect(within(liveRow).getByRole('button', { name: /^Revoke the MCP connection/ })).toBeInTheDocument()
    expect(within(deadRow).queryByRole('button', { name: /^Revoke/ })).toBeNull()
    expect(deadRow.textContent).toContain('revoked')

    await userEvent.click(within(liveRow).getByRole('button', { name: 'Revoke the MCP connection laptop agent' }))
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/mcp-connections/c1/revoke',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })
})
