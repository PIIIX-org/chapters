import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { RepositoryShare } from '../../api/repositories.js'
import { RepositoryShareList } from './RepositoryShareList.js'

// Both grantee kinds, because they render differently: a person is a bare
// uuid (the route serves no email yet — gap 5), a team carries its live
// membership.
const USER_SHARE: RepositoryShare = {
  id: 's1',
  repositoryId: 'r1',
  granteeType: 'user',
  granteeId: 'ada-uuid',
  createdAt: '2026-08-20T09:00:00.000Z',
}
const TEAM_SHARE: RepositoryShare = {
  id: 's2',
  repositoryId: 'r1',
  granteeType: 'team',
  granteeId: 'team-uuid',
  createdAt: '2026-08-21T09:00:00.000Z',
  members: [{ teamId: 'team-uuid', userId: 'u9', email: 'grace@example.com' }],
}

const TEAMS = [{ id: 'team-uuid', name: 'Platform', role: 'member' }]

interface Stubs {
  shares?: () => Response
  lookup?: () => Response
  create?: () => Response
  revoke?: () => Response
}

function renderList(stubs: Stubs = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/users/lookup')) {
      return Promise.resolve(stubs.lookup?.() ?? mockJsonResponse(200, { id: 'ada-uuid', email: 'ada@example.com' }))
    }
    if (url === '/api/teams') return Promise.resolve(mockJsonResponse(200, TEAMS))
    if (init?.method === 'DELETE') {
      return Promise.resolve(stubs.revoke?.() ?? mockJsonResponse(200, { status: 'revoked' }))
    }
    if (init?.method === 'POST') {
      return Promise.resolve(stubs.create?.() ?? mockJsonResponse(200, USER_SHARE))
    }
    if (url === '/api/repositories/r1/shares') {
      return Promise.resolve(stubs.shares?.() ?? mockJsonResponse(200, [USER_SHARE, TEAM_SHARE]))
    }
    throw new Error(`unstubbed request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RepositoryShareList repositoryId="r1" />
    </QueryClientProvider>,
  )
  return { ...result, fetchMock }
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, method: string): unknown {
  const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method)
  return JSON.parse((call![1] as RequestInit).body as string)
}

describe('RepositoryShareList', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists people and teams with no permission level anywhere', async () => {
    const { container } = renderList()

    expect(await screen.findByText('ada-uuid')).toBeInTheDocument()
    expect(screen.getByText('Team: Platform')).toBeInTheDocument()
    expect(screen.getByText('grace@example.com')).toBeInTheDocument()

    // The vault panel's read/edit selector must not have been copied here:
    // there is no edit tier, because nothing in a repository is editable.
    expect(screen.queryByRole('option', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Read' })).toBeNull()
    expect(screen.queryByLabelText(/permission/i)).toBeNull()
    // One select on the panel — the team picker, not a permission picker.
    expect(screen.getAllByRole('combobox')).toHaveLength(1)

    await expectNoA11yViolations(container)
  })

  it('turns an email into a grant with no permission field', async () => {
    const { fetchMock } = renderList()
    await screen.findByText('ada-uuid')

    await userEvent.type(screen.getByLabelText('Share with a person'), 'ada@example.com')
    await userEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]!)

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/repositories/r1/shares',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    expect(bodyOf(fetchMock, 'POST')).toEqual({ granteeType: 'user', granteeId: 'ada-uuid' })
    expect(fetchMock).toHaveBeenCalledWith('/api/users/lookup?email=ada%40example.com', expect.anything())
  })

  it('shares with a chosen team by id', async () => {
    const { fetchMock } = renderList()
    await screen.findByText('ada-uuid')

    await userEvent.selectOptions(screen.getByLabelText('Share with a team'), 'team-uuid')
    await userEvent.click(screen.getAllByRole('button', { name: 'Add' })[1]!)

    await waitFor(() => expect(bodyOf(fetchMock, 'POST')).toEqual({ granteeType: 'team', granteeId: 'team-uuid' }))
  })

  it('says an unknown email has no account here, and grants nothing', async () => {
    const { fetchMock } = renderList({ lookup: () => mockJsonResponse(404, { error: 'not found' }) })
    await screen.findByText('ada-uuid')

    await userEvent.type(screen.getByLabelText('Share with a person'), 'nobody@example.com')
    await userEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]!)

    expect(await screen.findByRole('alert')).toHaveTextContent('No active account with that email')
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(
      false,
    )
  })

  it('names who loses access before revoking, and calls nothing until confirmed', async () => {
    const { fetchMock } = renderList()
    await screen.findByText('ada-uuid')
    const callsBefore = fetchMock.mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: 'Revoke access for Platform' }))

    expect(screen.getByText(/Platform loses this repository immediately/)).toBeInTheDocument()
    expect(screen.getByText(/Their own copies of the code are untouched/)).toBeInTheDocument()
    expect(fetchMock.mock.calls).toHaveLength(callsBefore)

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/repositories/r1/shares/s2',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    )
  })

  it('reports a roster that failed to load instead of "no one else has access"', async () => {
    renderList({ shares: () => mockJsonResponse(500, { error: 'database is down' }) })

    expect(await screen.findByRole('alert')).toHaveTextContent('database is down')
    expect(screen.queryByText('No one else has access to this repository yet.')).toBeNull()
  })
})
