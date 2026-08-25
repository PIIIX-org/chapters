import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { SyncToken } from '../../api/repositories.js'
import { SyncTokenList } from './SyncTokenList.js'

// Three tokens along the two axes this list branches on: used vs never used,
// and live vs revoked. A component that renders every row, or that renders
// only the first, fails on this fixture.
const USED: SyncToken = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  createdAt: '2026-08-20T09:00:00.000Z',
  lastUsedAt: '2026-08-24T18:30:00.000Z',
  revokedAt: null,
}
const NEVER_USED: SyncToken = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  createdAt: '2026-08-22T09:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
}
const REVOKED: SyncToken = {
  id: 'cccccccc-3333-4333-8333-333333333333',
  createdAt: '2026-08-01T09:00:00.000Z',
  lastUsedAt: '2026-08-02T09:00:00.000Z',
  revokedAt: '2026-08-03T09:00:00.000Z',
}

const NEW_TOKEN = 'rst_9f2c41ab7d'

interface Stubs {
  list?: () => Response
  create?: () => Response
  revoke?: () => Response
}

function renderList(stubs: Stubs = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/revoke')) {
      return Promise.resolve(stubs.revoke?.() ?? mockJsonResponse(200, { status: 'revoked' }))
    }
    if (url.endsWith('/sync-tokens') && init?.method === 'POST') {
      return Promise.resolve(stubs.create?.() ?? mockJsonResponse(200, { token: NEW_TOKEN }))
    }
    if (url.endsWith('/sync-tokens')) {
      return Promise.resolve(stubs.list?.() ?? mockJsonResponse(200, [USED, NEVER_USED, REVOKED]))
    }
    throw new Error(`unstubbed request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <SyncTokenList repositoryId="r1" />
    </QueryClientProvider>,
  )
  return { ...result, fetchMock }
}

const CREATE = { name: 'Create sync token' }

describe('SyncTokenList', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists the live tokens with how each was last used, and leaves revoked ones out', async () => {
    const { container } = renderList()

    expect(await screen.findByText('aaaaaaaa')).toBeInTheDocument()
    expect(screen.getByText('bbbbbbbb')).toBeInTheDocument()
    // A revoked token grants nothing; listing it would misstate who can push.
    expect(screen.queryByText('cccccccc')).toBeNull()
    expect(screen.getByText('Never used')).toBeInTheDocument()
    expect(screen.getAllByText(/^Last used /)).toHaveLength(1)

    await expectNoA11yViolations(container)
  })

  it('shows a created token exactly once and drops it on dismiss', async () => {
    renderList()
    await screen.findByText('aaaaaaaa')

    await userEvent.click(screen.getByRole('button', CREATE))

    expect(await screen.findByText(NEW_TOKEN)).toBeInTheDocument()
    expect(screen.queryAllByText(NEW_TOKEN)).toHaveLength(1)
    expect(screen.getByText(/only time this value is shown/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText(NEW_TOKEN)).toBeNull()
  })

  it('says what revoking a token stops before it revokes, and calls nothing until confirmed', async () => {
    const { fetchMock } = renderList()
    await screen.findByText('aaaaaaaa')
    const callsBefore = fetchMock.mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: 'Revoke sync token bbbbbbbb' }))

    expect(screen.getByText(/stops being able to send files/)).toBeInTheDocument()
    expect(screen.getByText(/Everything already indexed stays/)).toBeInTheDocument()
    expect(fetchMock.mock.calls).toHaveLength(callsBefore)

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/repositories/r1/sync-tokens/${NEVER_USED.id}/revoke`,
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  it('reports a list that failed to load instead of "no sync tokens yet"', async () => {
    renderList({ list: () => mockJsonResponse(500, { error: 'database is down' }) })

    expect(await screen.findByRole('alert')).toHaveTextContent('database is down')
    expect(screen.queryByText('No sync tokens for this repository yet.')).toBeNull()
  })

  it('surfaces a rejected create inline instead of an empty reveal', async () => {
    renderList({ create: () => mockJsonResponse(404, { error: 'not found' }) })
    await screen.findByText('aaaaaaaa')

    await userEvent.click(screen.getByRole('button', CREATE))

    expect(await screen.findByRole('alert')).toHaveTextContent('not found')
    expect(screen.queryByText(/only time this value is shown/)).toBeNull()
  })
})
