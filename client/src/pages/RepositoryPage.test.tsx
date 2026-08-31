import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../lib/api.js'
import { expectNoA11yViolations } from '../test/axe.js'
import { routes } from '../router.js'

const SESSION = {
  id: 'me',
  email: 'me@example.com',
  status: 'active',
  role: 'member' as const,
  createdAt: '2026-08-01T00:00:00.000Z',
  mfaEnabledAt: null,
  mfaRequired: false,
}

// Two repositories, and the axis that matters is access: both are git-sourced
// (so the webhook card's own `ingestionMethod` guard cannot be what hides it),
// one owned and one reached through a share. The shared row carries the
// credential-stripped remote, because that is exactly what the server serves a
// viewer (`repositoryFields` → `publicGitUrl`) — a viewer can deep-link but
// never sees how the owner authenticated.
const OWNED = {
  id: 'r1',
  name: 'Chapters',
  ownerId: 'me',
  ingestionMethod: 'git' as const,
  gitUrl: 'https://github.com/piiix-org/chapters.git',
  localPath: null,
  defaultBranch: 'dev',
  mergeable: true,
  syncStatus: 'idle' as const,
  lastSyncedAt: '2026-08-24T11:00:00.000Z',
  lastSyncError: null,
  lastWebhookAt: null,
  webhookConfigured: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  access: 'owner' as const,
}

const SHARED = {
  ...OWNED,
  id: 'r2',
  name: 'Atlas ERP',
  ownerId: 'someone-else',
  gitUrl: 'https://github.com/piiix-org/atlas-erp.git',
  defaultBranch: null,
  webhookConfigured: true,
  access: 'viewer' as const,
}

// Two files, two languages, two directories — a page that renders one
// hardcoded entry, or sorts by nothing, cannot pass on this.
const FILES = [
  {
    id: 'f1',
    path: 'server/src/app.ts',
    language: 'typescript',
    size: 44,
    updatedAt: '2026-08-24T11:00:00.000Z',
  },
  {
    id: 'f2',
    path: 'scripts/seed.py',
    language: 'python',
    size: 21,
    updatedAt: '2026-08-24T11:00:00.000Z',
  },
]

const CONTENT: Record<string, unknown> = {
  'server/src/app.ts': {
    ...FILES[0],
    content: 'export function buildApp() { return 1 }',
    contentHash: 'sha256-a',
    sourceModifiedAt: null,
    symbols: [{ name: 'buildApp', kind: 'function', startLine: 1, endLine: 1 }],
  },
  'scripts/seed.py': {
    ...FILES[1],
    content: 'def seed():\n    return 2',
    contentHash: 'sha256-b',
    sourceModifiedAt: null,
    symbols: [{ name: 'seed', kind: 'function', startLine: 1, endLine: 2 }],
  },
}

function stubApi(opts?: { repositories?: () => Response }) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/me') return Promise.resolve(mockJsonResponse(200, SESSION))
    if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, []))
    if (url.startsWith('/api/notifications')) return Promise.resolve(mockJsonResponse(200, []))
    if (url === '/api/repositories') {
      return Promise.resolve(opts?.repositories?.() ?? mockJsonResponse(200, [OWNED, SHARED]))
    }
    if (url.startsWith('/api/repositories/') && url.includes('/files/content?path=')) {
      const path = decodeURIComponent(url.split('path=')[1]!)
      const file = CONTENT[path]
      return Promise.resolve(
        file ? mockJsonResponse(200, file) : mockJsonResponse(404, { error: 'not found' }),
      )
    }
    if (/^\/api\/repositories\/[^/]+\/files$/.test(url)) {
      return Promise.resolve(mockJsonResponse(200, FILES))
    }
    // The owner-only settings modal's own sections, quiet by default.
    if (url.endsWith('/shares') || url.endsWith('/sync-tokens')) {
      return Promise.resolve(mockJsonResponse(200, []))
    }
    if (url.endsWith('/graph-preference')) return Promise.resolve(mockJsonResponse(200, { include: false }))
    if (url === '/api/teams') return Promise.resolve(mockJsonResponse(200, []))
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Mounted through the app's own route table, not by rendering the component
 * directly: this unit's page was written before anything routed to it, and
 * "the component works" was never the missing half.
 */
function renderAt(pathname: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(routes, { initialEntries: [pathname] })
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, container }
}

describe('RepositoryPage route', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the repository and the file at /repos/:id/files/*', async () => {
    stubApi()
    const { container } = renderAt('/repos/r1/files/server/src/app.ts')

    expect(await screen.findByRole('heading', { level: 1, name: 'Chapters' })).toBeInTheDocument()

    // The splat kept every segment of the path, so the right file is open.
    const code = await screen.findByRole('textbox', { name: 'server/src/app.ts (read-only)' })
    expect(code.textContent).toContain('export function buildApp()')
    expect(code.getAttribute('contenteditable')).toBe('false')

    // Both files reachable from the tree column, and the open one marked.
    const openLink = screen.getByRole('link', { name: 'server/src/app.ts' })
    expect(openLink).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'scripts/seed.py' })).not.toHaveAttribute('aria-current')

    await expectNoA11yViolations(container)
  })

  it('switching files in the tree loads that file at its own URL', async () => {
    stubApi()
    const { router } = renderAt('/repos/r1/files/server/src/app.ts')

    await screen.findByRole('textbox', { name: 'server/src/app.ts (read-only)' })
    await userEvent.click(screen.getByRole('link', { name: 'scripts/seed.py' }))

    expect(router.state.location.pathname).toBe('/repos/r1/files/scripts/seed.py')
    const code = await screen.findByRole('textbox', { name: 'scripts/seed.py (read-only)' })
    expect(code.textContent).toContain('def seed():')
  })

  it('opens the repository from ⌘K and lands on the viewer route', async () => {
    stubApi()
    const { router } = renderAt('/')

    // Wait for the session first: RequireAuth renders nothing while it is
    // pending, so ⌘K's own listener does not exist yet. The shell's command
    // trigger is the first thing that proves the session resolved.
    await screen.findByRole('button', { name: 'Open the command palette' })
    // The palette is bound to Cmd on macOS and Ctrl elsewhere; sending both
    // keeps the test off whatever `navigator.platform` happens to say here.
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true })

    const option = await screen.findByRole('option', { name: 'Command: Open repository: Chapters' })
    await userEvent.click(option)

    expect(router.state.location.pathname).toBe('/repos/r1/files')
    // No file chosen yet is a real state of this route, not a 404.
    expect(await screen.findByRole('heading', { level: 1, name: 'Chapters' })).toBeInTheDocument()
    expect(screen.getByText(/Pick a file to read it/)).toBeInTheDocument()
  })

  it('offers one ⌘K entry per repository, shared ones included', async () => {
    stubApi()
    const { router } = renderAt('/')

    await screen.findByRole('button', { name: 'Open the command palette' })
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true })

    const option = await screen.findByRole('option', { name: 'Command: Open repository: Atlas ERP' })
    await userEvent.click(option)
    expect(router.state.location.pathname).toBe('/repos/r2/files')
  })

  it('keeps the owner-only webhook card away from a viewer', async () => {
    stubApi()
    renderAt('/repos/r1/files')

    // Owner, git repository: the inspector offers the Webhook tab, and the
    // card is behind it.
    await userEvent.click(await screen.findByRole('tab', { name: 'Webhook' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Webhook' })).toBeInTheDocument()

    vi.unstubAllGlobals()
    stubApi()
    const shared = renderAt('/repos/r2/files')
    expect(await screen.findByRole('heading', { level: 1, name: 'Atlas ERP' })).toBeInTheDocument()
    // A viewer does not even get the tab, let alone the card.
    expect(within(shared.container).queryByRole('tab', { name: 'Webhook' })).toBeNull()
    expect(within(shared.container).queryByRole('heading', { name: 'Webhook' })).toBeNull()
    expect(within(shared.container).getByText('Shared with you')).toBeInTheDocument()
  })

  it('opens the settings modal from the header, for the owner only', async () => {
    stubApi()
    renderAt('/repos/r1/files')

    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    const dialog = await screen.findByRole('dialog', { name: /repository settings — chapters/i })
    // The three surfaces this unit was missing, all reached from here.
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument()
    expect(within(dialog).getByRole('heading', { level: 3, name: 'Sharing' })).toBeInTheDocument()
    expect(within(dialog).getByRole('heading', { level: 3, name: 'Sync tokens' })).toBeInTheDocument()

    vi.unstubAllGlobals()
    stubApi()
    const shared = renderAt('/repos/r2/files')
    expect(await screen.findByRole('heading', { level: 1, name: 'Atlas ERP' })).toBeInTheDocument()
    // Every control behind it is requireOwner server side; a disabled button
    // would advertise a door that isn't theirs.
    expect(within(shared.container).queryByRole('button', { name: 'Settings' })).toBeNull()
  })

  it('gives a viewer of a git-sourced repository the same deep link the owner gets', async () => {
    stubApi()
    renderAt('/repos/r2/files/server/src/app.ts')

    const link = await screen.findByRole('link', { name: 'Open server/src/app.ts on GitHub' })
    // `HEAD` because this row has no defaultBranch yet — GitHub resolves it to
    // the default branch, so the link works before the first sync lands.
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/piiix-org/atlas-erp/blob/HEAD/server/src/app.ts',
    )
  })

  it('a failed repository fetch reports the failure instead of "not available to you"', async () => {
    stubApi({ repositories: () => mockJsonResponse(500, { error: 'database is down' }) })
    renderAt('/repos/r1/files')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('database is down')).toBeInTheDocument()
    // The permissions answer must never stand in for a broken request.
    expect(screen.queryByText(/isn’t available to you/)).toBeNull()
  })
})
