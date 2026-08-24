import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { VaultMcpPanel } from './VaultMcpPanel'
import type { McpConnection } from '../../api/mcp'

const ACCOUNT_SCOPED: McpConnection = {
  id: 'c-account',
  name: 'Account-wide agent',
  scope: 'account',
  vaultId: null,
  repositoryId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}

const OTHER_VAULT: McpConnection = {
  id: 'c-other-vault',
  name: 'Other vault agent',
  scope: 'vault',
  vaultId: 'v-other',
  repositoryId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}

const THIS_VAULT: McpConnection = {
  id: 'c1',
  name: 'Claude',
  scope: 'vault',
  vaultId: 'v1',
  repositoryId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}

// Every test builds a fresh Response per call — this panel both queries and
// mutates (create + revoke), and mockResolvedValue would hand back the same
// drained Response body across those calls.
function stubFetch(opts: {
  connections?: McpConnection[] | 'error'
  onCall?: (url: string, init?: RequestInit) => void
}) {
  let connections = opts.connections ?? [ACCOUNT_SCOPED, OTHER_VAULT, THIS_VAULT]
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    opts.onCall?.(url, init)
    if (url.includes('/mcp-connections') && url.endsWith('/revoke')) {
      const id = url.split('/').at(-2)
      if (Array.isArray(connections)) {
        connections = connections.map((c) => (c.id === id ? { ...c, revokedAt: '2026-08-23T00:00:00.000Z' } : c))
      }
      return Promise.resolve(mockJsonResponse(200, { status: 'revoked' }))
    }
    if (url === '/api/mcp-connections' && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { name: string; scope: string; vaultId?: string }
      const created: McpConnection & { token: string } = {
        id: 'c-new',
        name: body.name,
        scope: body.scope as McpConnection['scope'],
        vaultId: body.vaultId ?? null,
        repositoryId: null,
        createdAt: '2026-08-23T00:00:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        token: 'mcp_live_secret_token',
      }
      if (Array.isArray(connections)) connections = [...connections, created]
      return Promise.resolve(mockJsonResponse(200, created))
    }
    if (url === '/api/mcp-connections') {
      if (connections === 'error') return Promise.resolve(mockJsonResponse(500, { error: 'boom' }))
      return Promise.resolve(mockJsonResponse(200, connections))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPanel(vaultId = 'v1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <VaultMcpPanel vaultId={vaultId} />
    </QueryClientProvider>,
  )
}

describe('VaultMcpPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('filters to only this vault\'s connections — account-scoped and other-vault rows are dropped', async () => {
    stubFetch({})
    renderPanel()

    expect(await screen.findByText('Claude')).toBeInTheDocument()
    expect(screen.queryByText('Account-wide agent')).toBeNull()
    expect(screen.queryByText('Other vault agent')).toBeNull()
  })

  it('does not render a connection whose revokedAt is set', async () => {
    stubFetch({ connections: [{ ...THIS_VAULT, revokedAt: '2026-08-20T00:00:00.000Z' }] })
    renderPanel()

    await screen.findByText('No MCP connections for this vault yet.')
    expect(screen.queryByText('Claude')).toBeNull()
  })

  it('create POSTs /api/mcp-connections with scope vault and this vaultId', async () => {
    const fetchMock = stubFetch({ connections: [] })
    const user = userEvent.setup()
    renderPanel()

    await screen.findByText('No MCP connections for this vault yet.')

    await user.type(screen.getByLabelText('New connection'), 'Claude')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[0] === '/api/mcp-connections' && (c[1] as RequestInit)?.method === 'POST')).toBe(
        true,
      ),
    )
    const postCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/mcp-connections' && (c[1] as RequestInit)?.method === 'POST',
    ) as [string, RequestInit]
    expect(JSON.parse(postCall[1].body as string)).toEqual({ name: 'Claude', scope: 'vault', vaultId: 'v1' })
  })

  it('shows the returned token once, clears it on Done, and never leaks it into the refetched row', async () => {
    stubFetch({ connections: [] })
    const user = userEvent.setup()
    renderPanel()

    await screen.findByText('No MCP connections for this vault yet.')

    await user.type(screen.getByLabelText('New connection'), 'Claude')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('mcp_live_secret_token')).toBeInTheDocument()

    // The refetched list now shows the row — the token must not be on it.
    await screen.findByText('Claude')

    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.queryByText('mcp_live_secret_token')).toBeNull()
    expect(screen.getByText('Claude')).toBeInTheDocument()
  })

  it('lastUsedAt: null renders "Never used", not an empty cell or Invalid Date', async () => {
    stubFetch({ connections: [THIS_VAULT] })
    renderPanel()

    await screen.findByText('Claude')
    expect(screen.getByText('Never used')).toBeInTheDocument()
    expect(screen.queryByText(/invalid date/i)).toBeNull()
  })

  it('revoke requires a second click naming the connection, then POSTs the revoke endpoint (never DELETE)', async () => {
    const fetchMock = stubFetch({ connections: [THIS_VAULT] })
    const user = userEvent.setup()
    renderPanel()

    const nameNode = await screen.findByText('Claude')
    const row = nameNode.closest('li') as HTMLElement

    await user.click(within(row).getByRole('button', { name: 'Revoke' }))

    // First click must not fire a request yet.
    expect(fetchMock.mock.calls.some((c) => (c[0] as string).endsWith('/revoke'))).toBe(false)

    const confirmText = await within(row).findByText(/Revoke Claude\?/)
    expect(confirmText).toHaveTextContent(/loses access/)
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'DELETE')).toBe(false)

    await user.click(within(row).getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/mcp-connections/c1/revoke',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'DELETE')).toBe(false)
  })

  it('a load error renders an error, not the empty-state sentence, and is accessible', async () => {
    stubFetch({ connections: 'error' })
    const { container } = renderPanel()

    expect(await screen.findByText("Could not load this vault's MCP connections. Try again.")).toBeInTheDocument()
    expect(screen.queryByText('No MCP connections for this vault yet.')).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations in the loaded state', async () => {
    stubFetch({})
    const { container } = renderPanel()

    await screen.findByText('Claude')
    await expectNoA11yViolations(container)
  })
})
