import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { VaultReachExpansion } from './VaultReachExpansion.js'
import type { Vault } from '../../api/vaults.js'
import type { Share } from '../../api/shares.js'

const VAULTS: Vault[] = [
  { id: 'v1', name: 'Research', ownerId: 'me', mergeable: true, access: 'owner' },
  { id: 'v2', name: 'Shared with me', ownerId: 'someone-else', mergeable: true, access: 'read' },
]

const ONE_USER_ONE_TEAM_SHARES: Share[] = [
  {
    id: 's1',
    vaultId: 'v1',
    granteeType: 'user',
    granteeId: 'u-ada',
    permission: 'edit',
    createdAt: '2026-08-01T00:00:00.000Z',
    email: 'ada@example.com',
  },
  {
    id: 's2',
    vaultId: 'v1',
    granteeType: 'team',
    granteeId: 't1',
    permission: 'read',
    createdAt: '2026-08-01T00:00:00.000Z',
    members: [
      { teamId: 't1', userId: 'u-bea', email: 'bea@example.com' },
      { teamId: 't1', userId: 'u-cal', email: 'cal@example.com' },
    ],
  },
]

// One fresh Response per call — mockResolvedValue would hand back the same
// Response object across the vaults + shares queries this component fires,
// and a body stream can only be read once.
function stubFetch(opts: { vaults?: Vault[]; shares?: Share[] | 'error' }) {
  const vaults = opts.vaults ?? VAULTS
  const shares = opts.shares ?? ONE_USER_ONE_TEAM_SHARES
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/shares')) {
      if (shares === 'error') return Promise.resolve(mockJsonResponse(500, { error: 'boom' }))
      return Promise.resolve(mockJsonResponse(200, shares))
    }
    if (url.includes('/vaults')) return Promise.resolve(mockJsonResponse(200, vaults))
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderExpansion() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <VaultReachExpansion />
    </QueryClientProvider>,
  )
}

describe('VaultReachExpansion', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not fetch shares until expanded, then fetches exactly once', async () => {
    const fetchMock = stubFetch({})
    const user = userEvent.setup()
    renderExpansion()

    const button = await screen.findByRole('button', { name: 'Who can reach Research' })
    expect(fetchMock.mock.calls.some((c) => (c[0] as string).includes('/shares'))).toBe(false)

    await user.click(button)
    await screen.findByText(/people can reach this vault right now/)

    const shareCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).includes('/shares'))
    expect(shareCalls).toHaveLength(1)
    expect(shareCalls[0]![0]).toBe('/api/vaults/v1/shares')
  })

  it('counts distinct people: owner + direct user share + both team members', async () => {
    stubFetch({})
    const user = userEvent.setup()
    renderExpansion()

    await user.click(await screen.findByRole('button', { name: 'Who can reach Research' }))

    expect(await screen.findByText(/^4 people can reach this vault right now\./)).toBeInTheDocument()
  })

  it('counts a person reachable both directly and via a team once', async () => {
    stubFetch({
      shares: [
        {
          id: 's1',
          vaultId: 'v1',
          granteeType: 'user',
          granteeId: 'u-ada',
          permission: 'edit',
          createdAt: '2026-08-01T00:00:00.000Z',
          email: 'ada@example.com',
        },
        {
          id: 's2',
          vaultId: 'v1',
          granteeType: 'team',
          granteeId: 't1',
          permission: 'read',
          createdAt: '2026-08-01T00:00:00.000Z',
          members: [{ teamId: 't1', userId: 'u-ada', email: 'ada@example.com' }],
        },
      ],
    })
    const user = userEvent.setup()
    renderExpansion()

    await user.click(await screen.findByRole('button', { name: 'Who can reach Research' }))

    // Owner + ada, counted once despite appearing in both a user share and a
    // team's member list. A naive length sum (1 owner + 1 share + 1 member)
    // would say 3.
    expect(await screen.findByText(/^2 people can reach this vault right now\./)).toBeInTheDocument()
  })

  it('renders an expansion only for the owned vault, not the read-access one', async () => {
    stubFetch({})
    renderExpansion()

    expect(await screen.findByRole('button', { name: 'Who can reach Research' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Who can reach Shared with me' })).toBeNull()
  })

  it('flips aria-expanded and shows the actual member rows, not just the attribute', async () => {
    stubFetch({})
    const user = userEvent.setup()
    renderExpansion()

    const button = await screen.findByRole('button', { name: 'Who can reach Research' })
    expect(button).toHaveAttribute('aria-expanded', 'false')

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText(/ada@example\.com/)).toBeInTheDocument()
    expect(screen.getByText(/bea@example\.com/)).toBeInTheDocument()
    expect(screen.getByText(/cal@example\.com/)).toBeInTheDocument()
    expect(screen.getByText('You — owner')).toBeInTheDocument()
  })

  it('shows the no-shares empty state distinctly', async () => {
    stubFetch({ shares: [] })
    const user = userEvent.setup()
    renderExpansion()

    await user.click(await screen.findByRole('button', { name: 'Who can reach Research' }))

    expect(await screen.findByText('Only you can reach this vault.')).toBeInTheDocument()
  })

  it('renders an error, not the empty state, when the shares load fails', async () => {
    stubFetch({ shares: 'error' })
    const user = userEvent.setup()
    renderExpansion()

    await user.click(await screen.findByRole('button', { name: 'Who can reach Research' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i)
    expect(screen.queryByText('Only you can reach this vault.')).toBeNull()
  })

  it('has no accessibility violations expanded', async () => {
    stubFetch({})
    const user = userEvent.setup()
    const { container } = renderExpansion()

    await user.click(await screen.findByRole('button', { name: 'Who can reach Research' }))
    await screen.findByText(/people can reach this vault right now/)

    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations on the error state', async () => {
    stubFetch({ shares: 'error' })
    const user = userEvent.setup()
    const { container } = renderExpansion()

    await user.click(await screen.findByRole('button', { name: 'Who can reach Research' }))
    await screen.findByRole('alert')

    await expectNoA11yViolations(container)
  })
})
