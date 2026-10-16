import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { McpPanel, VaultMcpPanel } from './VaultMcpPanel'
import type { McpConnection, McpToolInfo } from '../../api/mcp'
import type { VaultAccess } from '../../api/vaults'

const ACCOUNT_SCOPED: McpConnection = {
  id: 'c-account',
  name: 'Account-wide agent',
  scope: 'account',
  vaultId: null,
  repositoryId: null,
  access: 'admin',
  allowedTools: null,
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
  access: 'write',
  allowedTools: null,
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
  access: 'write',
  allowedTools: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}

const TOOLS: McpToolInfo[] = [
  { name: 'list_vaults', scope: 'account', capability: 'read', pinPermission: 'read' },
  { name: 'read_note', scope: 'vault', capability: 'read', pinPermission: 'read' },
  { name: 'list_trash', scope: 'vault', capability: 'read', pinPermission: 'edit' },
  { name: 'list_vault_shares', scope: 'vault', capability: 'read', pinPermission: 'owner' },
  { name: 'create_note', scope: 'vault', capability: 'write', pinPermission: 'edit' },
  { name: 'share_vault', scope: 'vault', capability: 'admin', pinPermission: 'owner' },
  { name: 'search', scope: 'vault-or-repo', capability: 'read', pinPermission: 'read' },
]

function postBody(fetchMock: Mock): Record<string, unknown> {
  const postCall = fetchMock.mock.calls.find(
    (c) => c[0] === '/api/mcp-connections' && (c[1] as RequestInit)?.method === 'POST',
  ) as [string, RequestInit]
  return JSON.parse(postCall[1].body as string) as Record<string, unknown>
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
      const body = JSON.parse(init.body as string) as {
        name: string
        scope: string
        vaultId?: string
        access: McpConnection['access']
        allowedTools?: string[]
        expiresAt?: string
      }
      const created: McpConnection & { token: string } = {
        id: 'c-new',
        name: body.name,
        scope: body.scope as McpConnection['scope'],
        vaultId: body.vaultId ?? null,
        repositoryId: null,
        access: body.access,
        allowedTools: body.allowedTools ?? null,
        createdAt: '2026-08-23T00:00:00.000Z',
        lastUsedAt: null,
        expiresAt: body.expiresAt ?? null,
        revokedAt: null,
        token: 'mcp_live_secret_token',
      }
      if (Array.isArray(connections)) connections = [...connections, created]
      return Promise.resolve(mockJsonResponse(200, created))
    }
    if (url === '/api/mcp-connections/tools') return Promise.resolve(mockJsonResponse(200, TOOLS))
    if (url === '/api/mcp-connections') {
      if (connections === 'error') return Promise.resolve(mockJsonResponse(500, { error: 'boom' }))
      return Promise.resolve(mockJsonResponse(200, connections))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPanel(vaultId = 'v1', access: VaultAccess = 'owner') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <VaultMcpPanel vaultId={vaultId} access={access} />
    </QueryClientProvider>,
  )
}

function renderAccountPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <McpPanel scope="account" />
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

  it('create POSTs /api/mcp-connections with scope vault, this vaultId and write access by default', async () => {
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
    // No allow-list and no expiry unless chosen; the tool catalog is never fetched.
    expect(postBody(fetchMock)).toEqual({ name: 'Claude', scope: 'vault', vaultId: 'v1', access: 'write' })
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/mcp-connections/tools')).toBe(false)
  })

  it('a read-only token with a 30-day expiry sends access read and an expiresAt 30 days ahead', async () => {
    const fetchMock = stubFetch({ connections: [] })
    const user = userEvent.setup()
    renderPanel()

    await screen.findByText('No MCP connections for this vault yet.')
    await user.type(screen.getByLabelText('New connection'), 'Reader')
    await user.selectOptions(screen.getByLabelText('Access'), 'read')
    await user.selectOptions(screen.getByLabelText('Expires after'), '30')
    const before = Date.now()
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'POST')).toBe(true))
    const body = postBody(fetchMock)
    expect(body).toMatchObject({ name: 'Reader', scope: 'vault', vaultId: 'v1', access: 'read' })
    const days = (new Date(String(body.expiresAt)).getTime() - before) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(29.99)
    expect(days).toBeLessThan(30.01)
  })

  it('granting admin to a vault-pinned token shows a warning first', async () => {
    stubFetch({ connections: [] })
    const user = userEvent.setup()
    renderPanel()

    await screen.findByText('No MCP connections for this vault yet.')
    expect(screen.queryByText(/Admin lets this token share this vault/)).toBeNull()
    await user.selectOptions(screen.getByLabelText('Access'), 'admin')
    expect(screen.getByRole('alert')).toHaveTextContent(/share this vault.*move it to the trash, purge notes and erase history/)
  })

  it('a vault member who is not its owner is not offered admin (the API would refuse it)', async () => {
    const fetchMock = stubFetch({ connections: [] })
    const user = userEvent.setup()
    renderPanel('v1', 'edit')

    await screen.findByText('No MCP connections for this vault yet.')
    const options = within(screen.getByLabelText('Access')).getAllByRole('option')
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['read', 'write'])
    await user.type(screen.getByLabelText('New connection'), 'Member agent')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'POST')).toBe(true))
    expect(postBody(fetchMock)).toEqual({ name: 'Member agent', scope: 'vault', vaultId: 'v1', access: 'write' })
  })

  it('a member with a read-only share is offered read only, the default (#649)', async () => {
    const fetchMock = stubFetch({ connections: [] })
    const user = userEvent.setup()
    renderPanel('v1', 'read')

    await screen.findByText('No MCP connections for this vault yet.')
    expect(screen.getByLabelText('Access')).toHaveValue('read')
    const options = within(screen.getByLabelText('Access')).getAllByRole('option')
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['read'])
    await user.type(screen.getByLabelText('New connection'), 'Reader agent')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'POST')).toBe(true))
    expect(postBody(fetchMock)).toEqual({ name: 'Reader agent', scope: 'vault', vaultId: 'v1', access: 'read' })
  })

  it('an account token defaults to read and write, admin stays available, without the pinned-token warning', async () => {
    const fetchMock = stubFetch({ connections: [] })
    const user = userEvent.setup()
    renderAccountPanel()

    await screen.findByText('No account-wide MCP connections yet.')
    expect(screen.getByLabelText('Access')).toHaveValue('write')
    const options = within(screen.getByLabelText('Access')).getAllByRole('option')
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['read', 'write', 'admin'])
    await user.selectOptions(screen.getByLabelText('Access'), 'admin')
    expect(screen.queryByRole('alert')).toBeNull()
    await user.selectOptions(screen.getByLabelText('Access'), 'write')
    await user.type(screen.getByLabelText('New connection'), 'Laptop')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'POST')).toBe(true))
    expect(postBody(fetchMock)).toEqual({ name: 'Laptop', scope: 'account', access: 'write' })
  })

  it('the allow-list offers only tools the access level and the vault pin can use, and sends the picked ones', async () => {
    const fetchMock = stubFetch({ connections: [] })
    const user = userEvent.setup()
    renderPanel()

    await screen.findByText('No MCP connections for this vault yet.')
    await user.type(screen.getByLabelText('New connection'), 'Limited')
    await user.click(screen.getByLabelText('Limit this token to specific tools'))

    const group = await screen.findByRole('group', { name: 'Allowed tools' })
    await within(group).findByLabelText(/read_note/)
    expect(within(group).getByLabelText(/create_note/)).toBeInTheDocument()
    expect(within(group).getByLabelText(/search/)).toBeInTheDocument()
    // share_vault needs admin (this token is write); list_vaults is account-only.
    expect(within(group).queryByLabelText(/share_vault/)).toBeNull()
    expect(within(group).queryByLabelText(/list_vaults/)).toBeNull()

    // Nothing picked: refused before any request.
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('Pick at least one tool, or stop limiting the tools.')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'POST')).toBe(false)

    await user.click(within(group).getByLabelText(/read_note/))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'POST')).toBe(true))
    expect(postBody(fetchMock)).toEqual({ name: 'Limited', scope: 'vault', vaultId: 'v1', access: 'write', allowedTools: ['read_note'] })
  })

  it("the allow-list leaves out tools that need more than the user's own permission on the vault (#649)", async () => {
    stubFetch({ connections: [] })
    const user = userEvent.setup()
    renderPanel('v1', 'read')

    await screen.findByText('No MCP connections for this vault yet.')
    await user.click(screen.getByLabelText('Limit this token to specific tools'))
    const group = await screen.findByRole('group', { name: 'Allowed tools' })
    await within(group).findByLabelText(/read_note/)
    expect(within(group).getByLabelText(/search/)).toBeInTheDocument()
    // list_trash needs edit permission, list_vault_shares ownership: a read-only member gets neither.
    expect(within(group).queryByLabelText(/list_trash/)).toBeNull()
    expect(within(group).queryByLabelText(/list_vault_shares/)).toBeNull()
  })

  it('an editor is offered the edit-gated tools but not the owner-only ones', async () => {
    stubFetch({ connections: [] })
    const user = userEvent.setup()
    renderPanel('v1', 'edit')

    await screen.findByText('No MCP connections for this vault yet.')
    await user.click(screen.getByLabelText('Limit this token to specific tools'))
    const group = await screen.findByRole('group', { name: 'Allowed tools' })
    await within(group).findByLabelText(/list_trash/)
    expect(within(group).getByLabelText(/create_note/)).toBeInTheDocument()
    expect(within(group).queryByLabelText(/list_vault_shares/)).toBeNull()
  })

  it('the list shows each token\'s access, allow-list and expiry', async () => {
    stubFetch({
      connections: [
        { ...THIS_VAULT, access: 'read', allowedTools: ['read_note', 'search'], expiresAt: '2020-01-01T00:00:00.000Z' },
        { ...THIS_VAULT, id: 'c2', name: 'Writer' },
      ],
    })
    renderPanel()

    const row = (await screen.findByText('Claude')).closest('tr') as HTMLElement
    expect(row).toHaveTextContent('read')
    expect(row).toHaveTextContent('only read_note, search')
    expect(row).toHaveTextContent(/Expired/)
    const writer = screen.getByText('Writer').closest('tr') as HTMLElement
    expect(writer).toHaveTextContent('write')
    expect(writer).toHaveTextContent('all tools')
    expect(within(writer).getByText('Never')).toBeInTheDocument()
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
    const row = nameNode.closest('tr') as HTMLElement

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
