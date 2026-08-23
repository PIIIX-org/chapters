import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { SharingPanel } from './SharingPanel'
import type { Share } from '../../api/shares'

const SHARES: Share[] = [
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

// Every test builds a fresh Response per URL — mockResolvedValue would hand
// back the SAME Response object across the shares + teams calls this panel
// fires, and a body can only be read once.
function stubFetch(opts: { shares?: Share[] | 'error'; teams?: unknown[]; onCall?: (url: string, init?: RequestInit) => void }) {
  const shares = opts.shares ?? SHARES
  const teams = opts.teams ?? []
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    opts.onCall?.(url, init)
    if (url.includes('/users/lookup')) {
      if (url.includes('ada%40example.com')) return Promise.resolve(mockJsonResponse(200, { id: 'u-ada', email: 'ada@example.com' }))
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    }
    if (url.includes('/shares')) {
      if (shares === 'error') return Promise.resolve(mockJsonResponse(500, { error: 'boom' }))
      if (init?.method === 'POST') return Promise.resolve(mockJsonResponse(200, { id: 's-new', ...JSON.parse(init.body as string) }))
      if (init?.method === 'DELETE') return Promise.resolve(mockJsonResponse(200, { status: 'revoked' }))
      return Promise.resolve(mockJsonResponse(200, shares))
    }
    if (url.includes('/teams')) return Promise.resolve(mockJsonResponse(200, teams))
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPanel(vaultId = 'v1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SharingPanel vaultId={vaultId} />
    </QueryClientProvider>,
  )
}

describe('SharingPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the user share by email and the team share by its members’ emails', async () => {
    stubFetch({})
    renderPanel()

    expect(await screen.findByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByText('bea@example.com, cal@example.com')).toBeInTheDocument()
  })

  it('always shows the live-effect copy', async () => {
    stubFetch({})
    renderPanel()

    expect(
      await screen.findByText(
        'Access is re-checked on every request — a change here takes effect immediately, including for anyone reading right now.',
      ),
    ).toBeInTheDocument()
  })

  it('add-by-email looks up the email, then POSTs the share with the looked-up id', async () => {
    const fetchMock = stubFetch({ shares: [] })
    const user = userEvent.setup()
    renderPanel()

    await screen.findByText('No one else has access to this vault yet.')

    const emailInput = screen.getByLabelText('Share with a person')
    const emailForm = emailInput.closest('form') as HTMLElement
    await user.type(emailInput, 'ada@example.com')
    await user.selectOptions(screen.getByLabelText('Permission for this person'), 'edit')
    await user.click(within(emailForm).getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/users/lookup?email=ada%40example.com', expect.anything()))

    const shareCall = fetchMock.mock.calls.find(
      (c) => (c[0] as string) === '/api/vaults/v1/shares' && (c[1] as RequestInit)?.method === 'POST',
    )
    expect(shareCall).toBeDefined()
    const [, init] = shareCall as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      granteeType: 'user',
      granteeId: 'u-ada',
      permission: 'edit',
    })
  })

  it('a 404 lookup shows the inline not-found message and never POSTs a share', async () => {
    const fetchMock = stubFetch({ shares: [] })
    const user = userEvent.setup()
    renderPanel()

    await screen.findByText('No one else has access to this vault yet.')

    const emailInput = screen.getByLabelText('Share with a person')
    const emailForm = emailInput.closest('form') as HTMLElement
    await user.type(emailInput, 'ghost@example.com')
    await user.click(within(emailForm).getByRole('button', { name: 'Add' }))

    expect(
      await screen.findByText(
        'No active account with that email. They need an account on this instance before you can share with them.',
      ),
    ).toBeInTheDocument()

    const sharePost = fetchMock.mock.calls.find(
      (c) => (c[0] as string) === '/api/vaults/v1/shares' && (c[1] as RequestInit)?.method === 'POST',
    )
    expect(sharePost).toBeUndefined()
  })

  it('revoke requires a second click, names the grantee and consequence, and only then DELETEs', async () => {
    const fetchMock = stubFetch({})
    const user = userEvent.setup()
    renderPanel()

    const emailNode = await screen.findByText('ada@example.com')
    const row = emailNode.closest('li') as HTMLElement

    await user.click(within(row).getByRole('button', { name: 'Revoke' }))

    // First click must not have fired a DELETE yet.
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'DELETE')).toBe(false)

    const confirmText = await within(row).findByText(/Revoke edit access for ada@example\.com\?/)
    expect(confirmText).toHaveTextContent(/lose/)

    await user.click(within(row).getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v1/shares/s1', expect.objectContaining({ method: 'DELETE' })),
    )
  })

  it('load error renders an error message, not the empty-state sentence, and is accessible', async () => {
    stubFetch({ shares: 'error' })
    const { container } = renderPanel()

    expect(await screen.findByText('Could not load who has access to this vault. Try again.')).toBeInTheDocument()
    expect(screen.queryByText('No one else has access to this vault yet.')).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations in the loaded state', async () => {
    stubFetch({})
    const { container } = renderPanel()

    await screen.findByText('ada@example.com')
    await expectNoA11yViolations(container)
  })
})
