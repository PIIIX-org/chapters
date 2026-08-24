import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { Team, TeamMember } from '../../api/teams.js'
import { TeamManagement } from './TeamManagement.js'

// One owner team, one member team on purpose — a single-team fixture would
// let a missing owner gate pass.
const TEAMS: Team[] = [
  { id: 't1', name: 'Design', role: 'owner' },
  { id: 't2', name: 'Research', role: 'member' },
]

// t1's roster includes the owner row itself (u1) and a plain member (u2) —
// a fixture without the owner row would let a bug that offers Remove on it
// pass unnoticed.
const T1_MEMBERS: TeamMember[] = [
  { userId: 'u1', email: 'owner@example.com', role: 'owner' },
  { userId: 'u2', email: 'ada@example.com', role: 'member' },
]
const T2_MEMBERS: TeamMember[] = [{ userId: 'u3', email: 'other@example.com', role: 'member' }]

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function membersFor(teamId: string): TeamMember[] {
  if (teamId === 't1') return T1_MEMBERS
  if (teamId === 't2') return T2_MEMBERS
  return []
}

/** Base fetch stub: GET /teams and GET /teams/:id/members, nothing else. */
function baseFetchMock(teams: Team[] = TEAMS) {
  return vi.fn().mockImplementation((url: string) => {
    if (url === '/api/teams') return Promise.resolve(mockJsonResponse(200, teams))
    const membersMatch = /^\/api\/teams\/([^/]+)\/members$/.exec(url)
    if (membersMatch) return Promise.resolve(mockJsonResponse(200, membersFor(membersMatch[1]!)))
    return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
  })
}

describe('TeamManagement', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders management controls only for the owner team, and the member roster for both', async () => {
    vi.stubGlobal('fetch', baseFetchMock())
    renderWithClient(<TeamManagement />)

    // roster (plain member list) renders for both teams
    expect(await screen.findByText('owner@example.com')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(await screen.findByText('other@example.com')).toBeInTheDocument()

    // management controls: add-member form + delete-team trigger, owner card only
    expect(screen.getByLabelText('Add member to Design')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete design/i })).toBeInTheDocument()
    expect(screen.queryByLabelText('Add member to Research')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete research/i })).not.toBeInTheDocument()
  })

  it('shows Remove on the member row but not on the owner row', async () => {
    vi.stubGlobal('fetch', baseFetchMock())
    renderWithClient(<TeamManagement />)

    await screen.findByText('ada@example.com')

    expect(screen.getByRole('button', { name: /remove ada@example\.com from design/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /remove owner@example\.com from design/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('The team’s owner cannot be removed — delete the team instead.'),
    ).toBeInTheDocument()
  })

  it('add member: looks up the email, then POSTs the looked-up userId (not the email)', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/teams') return Promise.resolve(mockJsonResponse(200, TEAMS))
      if (url === '/api/teams/t1/members') return Promise.resolve(mockJsonResponse(200, T1_MEMBERS))
      if (url === '/api/teams/t2/members') return Promise.resolve(mockJsonResponse(200, T2_MEMBERS))
      if (url === '/api/users/lookup?email=new%40example.com') {
        return Promise.resolve(mockJsonResponse(200, { id: 'new-user-id', email: 'new@example.com' }))
      }
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<TeamManagement />)

    await screen.findByText('ada@example.com')
    await user.type(screen.getByLabelText('Add member to Design'), 'new@example.com')
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/users/lookup?email=new%40example.com', expect.anything()),
    )
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/teams/t1/members',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ userId: 'new-user-id' }) }),
      ),
    )
  })

  it('a 404 lookup shows the inline message and issues no POST to /members', async () => {
    const user = userEvent.setup()
    const fetchMock = baseFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<TeamManagement />)

    await screen.findByText('ada@example.com')
    await user.type(screen.getByLabelText('Add member to Design'), 'ghost@example.com')
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    expect(await screen.findByText('No active account with that email on this instance.')).toBeInTheDocument()
    const postCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(postCalls).toHaveLength(0)
  })

  it('remove requires a confirm step naming the email and the consequence, and only the confirm click DELETEs', async () => {
    const user = userEvent.setup()
    const fetchMock = baseFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<TeamManagement />)

    await screen.findByText('ada@example.com')
    await user.click(screen.getByRole('button', { name: /remove ada@example\.com from design/i }))

    // first click sends nothing yet
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(
      false,
    )

    const confirmText = screen.getByText(/remove ada@example\.com from design\?/i).textContent ?? ''
    expect(confirmText).toMatch(/lose access to every vault shared with this team, immediately/i)

    await user.click(within(screen.getByText(/remove ada@example\.com from design\?/i).parentElement!).getByRole('button', { name: /^remove$/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/teams/t1/members/u2', expect.objectContaining({ method: 'DELETE' })),
    )
  })

  it('delete team confirm names the member count and the share consequence, and only then DELETEs the team', async () => {
    const user = userEvent.setup()
    const fetchMock = baseFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<TeamManagement />)

    await screen.findByText('ada@example.com')
    await user.click(screen.getByRole('button', { name: /delete design/i }))

    const confirmText = screen.getByText(/delete design\?/i).textContent ?? ''
    expect(confirmText).toMatch(/its 2 members lose it/i)
    expect(confirmText).toMatch(/every vault shared with this team loses that share/i)
    expect(confirmText).toMatch(/this cannot be undone/i)

    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(
      false,
    )

    await user.click(screen.getByRole('button', { name: /^delete team$/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/teams/t1', expect.objectContaining({ method: 'DELETE' })),
    )
  })

  it('create team sends { name } and the new team appears after the refetch', async () => {
    const user = userEvent.setup()
    let teamsCallCount = 0
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/teams' && init?.method === 'POST') {
        return Promise.resolve(
          mockJsonResponse(200, { id: 't3', name: 'Marketing', role: 'owner' }),
        )
      }
      if (url === '/api/teams') {
        teamsCallCount += 1
        const teams = teamsCallCount === 1 ? TEAMS : [...TEAMS, { id: 't3', name: 'Marketing', role: 'owner' as const }]
        return Promise.resolve(mockJsonResponse(200, teams))
      }
      const membersMatch = /^\/api\/teams\/([^/]+)\/members$/.exec(url)
      if (membersMatch) {
        if (membersMatch[1] === 't3') return Promise.resolve(mockJsonResponse(200, []))
        return Promise.resolve(mockJsonResponse(200, membersFor(membersMatch[1]!)))
      }
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<TeamManagement />)

    await screen.findByText('ada@example.com')
    await user.type(screen.getByLabelText('New team name'), 'Marketing')
    await user.click(screen.getByRole('button', { name: /^create team$/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/teams',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Marketing' }) }),
      ),
    )
    expect(await screen.findByText('Marketing')).toBeInTheDocument()
  })

  it('has no accessibility violations in the loaded state', async () => {
    vi.stubGlobal('fetch', baseFetchMock())
    const { container } = renderWithClient(<TeamManagement />)
    await screen.findByText('ada@example.com')
    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations when team creation fails with a 500', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/teams' && init?.method === 'POST') {
        return Promise.resolve(mockJsonResponse(500, { error: 'internal error' }))
      }
      if (url === '/api/teams') return Promise.resolve(mockJsonResponse(200, TEAMS))
      const membersMatch = /^\/api\/teams\/([^/]+)\/members$/.exec(url)
      if (membersMatch) return Promise.resolve(mockJsonResponse(200, membersFor(membersMatch[1]!)))
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = renderWithClient(<TeamManagement />)

    await screen.findByText('ada@example.com')
    await user.type(screen.getByLabelText('New team name'), 'Broken')
    await user.click(screen.getByRole('button', { name: /^create team$/i }))

    await screen.findByRole('alert')
    await expectNoA11yViolations(container)
  })
})
