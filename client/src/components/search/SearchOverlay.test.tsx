import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { themeStore } from '../../lib/theme.js'
import { RECENTS_STORAGE_KEY, recentsStore, type Recent } from './recents.js'
import { SearchOverlay } from './SearchOverlay.js'

const FIXTURE = [
  {
    resourceType: 'note',
    id: 'n1',
    containerId: 'v1',
    path: 'people/jane',
    type: 'people',
    frontmatter: { tags: ['engineering'] },
    snippet: 'about jane',
    score: 0.91,
  },
  {
    resourceType: 'code',
    id: 'c1',
    containerId: 'r1',
    path: 'src/x.ts',
    language: 'typescript',
    snippet: 'export function x() { return 1 }',
    score: 0.5,
  },
]

function renderOverlay(open = true, initialEntry = '/', path = '/') {
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path, element: <SearchOverlay open={open} onClose={onClose} /> }],
    { initialEntries: [initialEntry] },
  )
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { onClose, router, container }
}

// The overlay also fires a `/vaults` request (for the command list), so the
// mock must branch on URL rather than blindly answering every fetch with the
// search fixture — and must build a fresh Response per call, since a Response
// body can only be read once and `useVaults` + `useSearch` (and StrictMode-ish
// re-fetches) can both land on the same mock.
function sessionUser(role: 'member' | 'admin') {
  return {
    id: 'me',
    email: 'me@example.com',
    status: 'active',
    role,
    createdAt: '2026-08-01T00:00:00.000Z',
  }
}

function stubFetch(search: () => Response, role: 'member' | 'admin' = 'member') {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.startsWith('/api/search')) return Promise.resolve(search())
    if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, []))
    // The overlay reads the session too: "Go to admin" is offered to admins
    // only, so the role has to come from somewhere.
    if (url === '/api/me') return Promise.resolve(mockJsonResponse(200, sessionUser(role)))
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function search(user: ReturnType<typeof userEvent.setup>, value: string) {
  const input = screen.getByPlaceholderText(/search/i)
  await user.type(input, value)
  await vi.advanceTimersByTimeAsync(300)
}

// Two distinctly named vaults — a one-vault fixture would let a "pick the
// first" bug pass.
const VAULTS = [
  { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' as const },
  { id: 'v2', name: 'Recipes', ownerId: 'u1', mergeable: true, access: 'owner' as const },
]

function stubCommandFetch(opts?: { createResponse?: Response }) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/search')) return Promise.resolve(mockJsonResponse(200, []))
    if (url === '/api/vaults' && (!init || init.method === undefined)) {
      return Promise.resolve(mockJsonResponse(200, VAULTS))
    }
    if (url === '/api/vaults' && init?.method === 'POST') {
      return Promise.resolve(
        opts?.createResponse ??
          mockJsonResponse(200, { id: 'v3', name: 'Atlas', ownerId: 'u1', mergeable: true, access: 'owner' }),
      )
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function storedRecents(): Recent[] {
  return JSON.parse(localStorage.getItem(RECENTS_STORAGE_KEY) ?? '[]') as Recent[]
}

// localStorage carries the theme and the recents across tests in this file
// (happy-dom keeps one window per file) — start every test from a blank
// history and the default dark theme, and drop both stores' caches.
beforeEach(() => {
  localStorage.clear()
  recentsStore.reset()
  themeStore.reset()
})

describe('SearchOverlay', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders nothing when closed', () => {
    renderOverlay(false)
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })

  it('renders both note and code results, with note chips and score', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubFetch(() => mockJsonResponse(200, FIXTURE))
    renderOverlay(true)

    await search(user, 'jane')

    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    expect(screen.getByText('src/x.ts')).toBeInTheDocument()

    // Note chips and score — scoped to the result option itself, since a
    // bare screen.getByText could collide with chrome elsewhere.
    const noteOption = screen.getByText('people/jane').closest('[role="option"]') as HTMLElement
    expect(within(noteOption).getByText('engineering')).toBeInTheDocument()
    expect(within(noteOption).getByText('people')).toBeInTheDocument()
    expect(within(noteOption).getByText('0.91')).toBeInTheDocument()

    // The code entry's full snippet is not shown until expanded.
    expect(screen.queryByText('export function x() { return 1 }')).toBeNull()
  })

  it('clicking a note result navigates, closes the overlay, and records a recent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubFetch(() => mockJsonResponse(200, FIXTURE))
    const { onClose, router } = renderOverlay(true)

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    await user.click(screen.getByText('people/jane'))
    expect(router.state.location.pathname).toBe('/vaults/v1/notes/people/jane')
    expect(onClose).toHaveBeenCalled()
    expect(storedRecents()[0]).toMatchObject({
      kind: 'note',
      label: 'people/jane',
      path: '/vaults/v1/notes/people/jane',
    })
  })

  it('clicking a code result toggles an inline preview without navigating or closing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubFetch(() => mockJsonResponse(200, FIXTURE))
    const { onClose, router } = renderOverlay(true)

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('src/x.ts')).toBeInTheDocument())

    // Not aria-expanded: role="option" doesn't permit it (aria-allowed-attr),
    // so the disclosure state is only ever visible in the rendered preview.
    const codeButton = screen.getByText('src/x.ts').closest('button') as HTMLElement
    expect(codeButton).toHaveAttribute('role', 'option')
    expect(screen.queryByText('export function x() { return 1 }')).toBeNull()
    await user.click(codeButton)

    expect(router.state.location.pathname).toBe('/')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('export function x() { return 1 }')).toBeInTheDocument()
    // A code preview is not a destination — nothing was recorded.
    expect(storedRecents()).toHaveLength(0)
  })

  it('renders an alert with a retry button on search failure, never the empty state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubFetch(() => mockJsonResponse(500, { error: 'search backend unavailable' }))
    const { container } = renderOverlay(true)

    await search(user, 'jane')

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByText('search backend unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByText(/no results/i)).toBeNull()

    // The alert (and its focusable Retry button) must not be a descendant of
    // #search-listbox (role="listbox" permits only option/group children) —
    // this is the one error-state test that actually catches that.
    await expectNoA11yViolations(container)
  })

  it('retry refetches and replaces the alert with results', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    let failing = true
    stubFetch(() => (failing ? mockJsonResponse(500, { error: 'down' }) : mockJsonResponse(200, FIXTURE)))
    renderOverlay(true)

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    failing = false
    await user.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes on Escape', async () => {
    // No explicit target: focus is already in the autofocused input, and the
    // handler lives on that input's onKeyDown — if it were ever moved to a
    // node the user never focuses, this Escape would silently do nothing.
    const user = userEvent.setup()
    const { onClose } = renderOverlay(true)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on a backdrop click but not on a click inside the panel', async () => {
    const user = userEvent.setup()
    const { onClose } = renderOverlay(true)
    const panel = screen.getByRole('dialog')
    const backdrop = panel.parentElement as HTMLElement

    // A click inside the panel must NOT close.
    await user.click(panel)
    expect(onClose).not.toHaveBeenCalled()

    // A click on the backdrop itself closes.
    await user.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has no accessibility violations with results rendered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubFetch(() => mockJsonResponse(200, FIXTURE))
    const { container } = renderOverlay(true)

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    await expectNoA11yViolations(container)
  })

  it('never uses the accent token for ordinary chrome (authorship colour is reserved)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubFetch(() => mockJsonResponse(200, FIXTURE))
    const { container } = renderOverlay(true)

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    const offenders = Array.from(container.querySelectorAll('*')).filter((el) =>
      Array.from(el.classList).some(
        (c) => c === 'bg-accent' || c === 'text-accent' || c.startsWith('hover:bg-accent'),
      ),
    )
    expect(offenders).toHaveLength(0)
  })

  it('offers "Go to admin" to an admin only', async () => {
    stubFetch(() => mockJsonResponse(200, []), 'admin')
    const { router } = renderOverlay()

    const adminCommand = await screen.findByRole('option', { name: 'Command: Go to admin' })
    await userEvent.click(adminCommand)
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'))
  })

  it('hides it from a member, who would only reach a wall', async () => {
    stubFetch(() => mockJsonResponse(200, []), 'member')
    renderOverlay()

    // The team command proves the command list rendered at all — without it
    // this passes just as well when nothing rendered.
    expect(await screen.findByRole('option', { name: 'Command: Go to team' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Command: Go to admin' })).toBeNull()
  })

  it('offers "Go to settings" to everyone, admin or not', async () => {
    stubFetch(() => mockJsonResponse(200, []), 'member')
    const { router } = renderOverlay()

    // Unlike admin, settings is every account's own page — a member reaching
    // it hits their settings, not a wall.
    await userEvent.click(await screen.findByRole('option', { name: 'Command: Go to settings' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })
})

describe('SearchOverlay commands', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shows actions and destinations on an empty query and never hits search', async () => {
    const fetchMock = stubCommandFetch()
    renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Open vault: Recipes' })).toBeInTheDocument(),
    )
    expect(screen.getByRole('option', { name: 'Command: Go to graph' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Command: Connect a repository' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Command: Switch theme' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /New vault/i })).toBeNull()

    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/search'))).toBe(false)
  })

  it('renders the groups in spec order under Eyebrow headers', async () => {
    stubCommandFetch()
    renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Open vault: Recipes' })).toBeInTheDocument(),
    )
    const listbox = screen.getByRole('listbox')
    const labels = within(listbox)
      .getAllByRole('group')
      .map((g) => g.getAttribute('aria-label'))
    // No repositories and no recents in this fixture; no query typed, so no
    // Results group either.
    expect(labels).toEqual(['Actions', 'Go to', 'Vaults'])
  })

  it('gives each Go to row its chord as a Kbd and its path as a mono hint', async () => {
    stubCommandFetch()
    renderOverlay(true)

    const option = await screen.findByRole('option', { name: 'Command: Go to vaults' })
    expect(within(option).getByText('g v')).toBeInTheDocument()
    expect(within(option).getByText('/vaults')).toBeInTheDocument()
  })

  it('filters commands by case-insensitive substring match', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubCommandFetch()
    renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Open vault: Recipes' })).toBeInTheDocument(),
    )

    await search(user, 'recip')

    expect(screen.getByRole('option', { name: 'Command: Open vault: Recipes' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Command: Open vault: Engineering' })).toBeNull()
  })

  it('clicking a vault command navigates to that vault, closes, and records a recent', async () => {
    stubCommandFetch()
    const { onClose, router } = renderOverlay(true)

    const option = await screen.findByRole('option', { name: 'Command: Open vault: Recipes' })
    await userEvent.click(option)

    expect(router.state.location.pathname).toBe('/vaults/v2')
    expect(onClose).toHaveBeenCalled()
    expect(storedRecents()[0]).toMatchObject({ kind: 'vault', label: 'Recipes', path: '/vaults/v2' })
  })

  it('activating a Go to command records an area recent', async () => {
    stubCommandFetch()
    const { router } = renderOverlay(true)

    await userEvent.click(await screen.findByRole('option', { name: 'Command: Go to team' }))

    expect(router.state.location.pathname).toBe('/team')
    expect(storedRecents()[0]).toMatchObject({ kind: 'area', label: 'Team', path: '/team' })
  })

  it('creates a vault from the typed query and navigates to the returned id', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchMock = stubCommandFetch({
      createResponse: mockJsonResponse(200, { id: 'v9', name: 'Atlas', ownerId: 'u1', mergeable: true, access: 'owner' }),
    })
    const { onClose, router } = renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to graph' })).toBeInTheDocument(),
    )
    await search(user, 'Atlas')

    const option = await screen.findByRole('option', { name: 'Command: New vault "Atlas"' })
    await user.click(option)

    await waitFor(() => expect(router.state.location.pathname).toBe('/vaults/v9'))
    expect(onClose).toHaveBeenCalled()

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/vaults' && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(postCall).toBeDefined()
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({ name: 'Atlas' })
  })

  it('keeps the overlay open and shows the error when creating a vault fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubCommandFetch({ createResponse: mockJsonResponse(500, { error: 'vault name already exists' }) })
    const { onClose, router } = renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to graph' })).toBeInTheDocument(),
    )
    await search(user, 'Atlas')

    const option = await screen.findByRole('option', { name: 'Command: New vault "Atlas"' })
    await user.click(option)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByText('vault name already exists')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cycles the theme dark → light and shows the next value as the hint', async () => {
    stubCommandFetch()
    const { onClose } = renderOverlay(true)

    const option = await screen.findByRole('option', { name: 'Command: Switch theme' })
    expect(within(option).getByText('dark → light')).toBeInTheDocument()

    await userEvent.click(option)

    expect(themeStore.get()).toBe('light')
    expect(onClose).toHaveBeenCalled()
  })

  it('never renders a command for a route that does not exist yet', async () => {
    stubCommandFetch()
    renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to graph' })).toBeInTheDocument(),
    )
    // Every Go to row mirrors CHORDS in useShellChords.ts — routes that all
    // exist in router.tsx. 'admin' stays on this list because it is
    // role-gated and this fixture answers no /api/me call, so no admin.
    // 'Open repository: …' rows are asserted end-to-end, against the app's
    // real route table, in pages/RepositoryPage.test.tsx. This fixture
    // answers no /api/repositories call, so the overlay offers none here.
    expect(screen.queryByRole('option', { name: /admin|invite/i })).toBeNull()
  })

  it('renders a "Go to team" command, and a query that cannot match it removes it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubCommandFetch()
    renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to team' })).toBeInTheDocument(),
    )

    await search(user, 'zzz')

    expect(screen.queryByRole('option', { name: 'Command: Go to team' })).toBeNull()
  })

  it('renders commands above results', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    // Real results (FIXTURE), not stubCommandFetch's empty array — otherwise
    // there is nothing for the commands to be above, and the test can't fail.
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/search')) return Promise.resolve(mockJsonResponse(200, FIXTURE))
      if (url === '/api/vaults' && (!init || init.method === undefined)) {
        return Promise.resolve(mockJsonResponse(200, VAULTS))
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to graph' })).toBeInTheDocument(),
    )
    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    const options = screen.getAllByRole('option')
    const firstCommandIndex = options.findIndex((o) => /^Command: /.test(o.getAttribute('aria-label') ?? ''))
    const firstNonCommandIndex = options.findIndex((o) => !/^Command: /.test(o.getAttribute('aria-label') ?? ''))
    expect(firstCommandIndex).toBeGreaterThanOrEqual(0)
    expect(firstNonCommandIndex).toBeGreaterThanOrEqual(0)
    expect(firstCommandIndex).toBeLessThan(firstNonCommandIndex)
  })

  it('has no accessibility violations with commands and results both populated', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/search')) return Promise.resolve(mockJsonResponse(200, FIXTURE))
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, VAULTS))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to graph' })).toBeInTheDocument(),
    )
    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    await expectNoA11yViolations(container)
  })
})

describe('SearchOverlay recents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function seedRecents(recents: Recent[]) {
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(recents))
    recentsStore.reset()
  }

  it('shows seeded recent destinations before typing, between Actions and Go to', async () => {
    seedRecents([
      { kind: 'vault', label: 'Recipes', path: '/vaults/v2' },
      { kind: 'note', label: 'people/jane', path: '/vaults/v1/notes/people/jane' },
    ])
    stubCommandFetch()
    const { container } = renderOverlay(true)

    const recent = await screen.findByRole('option', { name: 'Recent: Recipes' })
    expect(within(recent).getByText('/vaults/v2')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Recent: people/jane' })).toBeInTheDocument()

    // The recents come out of localStorage synchronously; the vault list is a
    // fetch — wait for it before asserting the full group order.
    await screen.findByRole('option', { name: 'Command: Open vault: Recipes' })

    const labels = within(screen.getByRole('listbox'))
      .getAllByRole('group')
      .map((g) => g.getAttribute('aria-label'))
    expect(labels).toEqual(['Actions', 'Recent', 'Go to', 'Vaults'])

    await expectNoA11yViolations(container)
  })

  it('clicking a recent navigates to its path, closes, and moves it to the front', async () => {
    seedRecents([
      { kind: 'note', label: 'people/jane', path: '/vaults/v1/notes/people/jane' },
      { kind: 'vault', label: 'Recipes', path: '/vaults/v2' },
    ])
    stubCommandFetch()
    const { onClose, router } = renderOverlay(true)

    await userEvent.click(await screen.findByRole('option', { name: 'Recent: Recipes' }))

    expect(router.state.location.pathname).toBe('/vaults/v2')
    expect(onClose).toHaveBeenCalled()
    expect(storedRecents().map((r) => r.label)).toEqual(['Recipes', 'people/jane'])
  })

  it('typing anything hides the Recent group', async () => {
    seedRecents([{ kind: 'vault', label: 'Recipes', path: '/vaults/v2' }])
    stubCommandFetch()
    renderOverlay(true)

    await screen.findByRole('option', { name: 'Recent: Recipes' })

    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/search/i), 'x')

    expect(screen.queryByRole('option', { name: 'Recent: Recipes' })).toBeNull()
  })
})

describe('SearchOverlay new-note action', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // One writable vault and one read-only: the action must know the
  // difference, not just the route.
  const NOTE_VAULTS = [
    { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' as const },
    { id: 'v2', name: 'Handbook', ownerId: 'u2', mergeable: true, access: 'read' as const },
  ]

  function stubNoteFetch(opts?: { createResponse?: Response }) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/search')) return Promise.resolve(mockJsonResponse(200, []))
      if (url === '/api/vaults' && (!init || init.method === undefined)) {
        return Promise.resolve(mockJsonResponse(200, NOTE_VAULTS))
      }
      if (url === '/api/vaults/v1/notes' && init?.method === 'POST') {
        return Promise.resolve(
          opts?.createResponse ??
            mockJsonResponse(200, { id: 'n9', path: 'people/jane', type: 'people', name: 'jane' }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('offers the action at a vault route once the query parses as type/name, creates the note and opens it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchMock = stubNoteFetch()
    const { onClose, router } = renderOverlay(true, '/vaults/v1', '/vaults/:vaultId')

    await search(user, 'people/jane')

    const option = await screen.findByRole('option', { name: 'Command: New note people/jane in Engineering' })
    await user.click(option)

    await waitFor(() => expect(router.state.location.pathname).toBe('/vaults/v1/notes/people/jane'))
    expect(onClose).toHaveBeenCalled()
    expect(storedRecents()[0]).toMatchObject({ kind: 'note', path: '/vaults/v1/notes/people/jane' })

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/vaults/v1/notes' && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(postCall).toBeDefined()
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({ type: 'people', name: 'jane' })
  })

  it('keeps the overlay open and surfaces the error when creating the note fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNoteFetch({ createResponse: mockJsonResponse(500, { error: 'note already exists' }) })
    const { onClose, router } = renderOverlay(true, '/vaults/v1', '/vaults/:vaultId')

    await search(user, 'people/jane')
    await user.click(await screen.findByRole('option', { name: 'Command: New note people/jane in Engineering' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByText('note already exists')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/vaults/v1')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('explains the type/name shape in the footer instead of offering a dead command', async () => {
    stubNoteFetch()
    renderOverlay(true, '/vaults/v1', '/vaults/:vaultId')

    // The vault list has to load before the footer knows where it is.
    await screen.findByText(/creates a note in Engineering/)
    expect(screen.queryByRole('option', { name: /New note/ })).toBeNull()
  })

  it('never offers it on a read-only vault', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNoteFetch()
    renderOverlay(true, '/vaults/v2', '/vaults/:vaultId')

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Open vault: Engineering' })).toBeInTheDocument(),
    )
    await search(user, 'people/jane')

    expect(screen.queryByRole('option', { name: /New note/ })).toBeNull()
    expect(screen.queryByText(/creates a note in/)).toBeNull()
  })

  it('never offers it outside a vault route', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNoteFetch()
    renderOverlay(true)

    await search(user, 'people/jane')

    expect(screen.queryByRole('option', { name: /New note/ })).toBeNull()
  })
})

describe('SearchOverlay keyboard navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // Two vaults (not one) so a "picks the first" bug can't pass, and a query
  // ('recip') that keeps the flat entry list small and unambiguous:
  // [New vault "recip", Open vault: Recipes] followed by results
  // [note, code] — four entries with distinct destinations.
  const NAV_VAULTS = [
    { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' as const },
    { id: 'v2', name: 'Recipes', ownerId: 'u1', mergeable: true, access: 'owner' as const },
  ]

  function stubNavFetch(opts?: { searchByQuery?: (q: string) => unknown[] }) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/search')) {
        const q = new URL(url, 'http://test').searchParams.get('q') ?? ''
        return Promise.resolve(mockJsonResponse(200, opts?.searchByQuery ? opts.searchByQuery(q) : FIXTURE))
      }
      if (url === '/api/vaults' && (!init || init.method === undefined)) {
        return Promise.resolve(mockJsonResponse(200, NAV_VAULTS))
      }
      if (url === '/api/vaults' && init?.method === 'POST') {
        return Promise.resolve(
          mockJsonResponse(200, { id: 'v9', name: 'recipzz', ownerId: 'u1', mergeable: true, access: 'owner' }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('ArrowDown then Enter activates entry index 1, not index 0', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNavFetch()
    const { onClose, router } = renderOverlay(true)

    await search(user, 'recip')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1)

    // Entry 0 is 'New vault "recip"' (a POST); entry 1 is "Open vault:
    // Recipes" (-> '/vaults/v2'). Only the second proves the arrow key
    // moved the index at all.
    await user.keyboard('{ArrowDown}{Enter}')

    expect(router.state.location.pathname).toBe('/vaults/v2')
    expect(onClose).toHaveBeenCalled()
  })

  it('ArrowUp as the first keystroke wraps to the last entry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNavFetch()
    const { onClose, router } = renderOverlay(true)

    await search(user, 'recip')
    await waitFor(() => expect(screen.getByText('src/x.ts')).toBeInTheDocument())

    // The last entry is the code result's inline-preview toggle: unlike
    // every other entry in this fixture it neither navigates nor closes, so
    // it's unambiguous proof of a real wrap rather than a clamp-at-0 bug.
    await user.keyboard('{ArrowUp}{Enter}')

    expect(router.state.location.pathname).toBe('/')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('export function x() { return 1 }')).toBeInTheDocument()
  })

  it('resets the active index when the entry list shrinks, so Enter cannot activate a stale row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchMock = stubNavFetch({ searchByQuery: (q) => (q === 'recipzz' ? [] : FIXTURE) })
    const { onClose, router } = renderOverlay(true)

    await search(user, 'recip')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    // Wrap straight to the last entry, then narrow the query so both the
    // command filter and the result set shrink to a single survivor: the
    // synthesized "new vault" command.
    await user.keyboard('{ArrowUp}')
    await search(user, 'zz')
    await waitFor(() => expect(screen.queryByText('people/jane')).toBeNull())
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: New vault "recipzz"' })).toBeInTheDocument(),
    )
    expect(screen.getAllByRole('option')).toHaveLength(1)

    await user.keyboard('{Enter}')

    await waitFor(() => expect(router.state.location.pathname).toBe('/vaults/v9'))
    expect(onClose).toHaveBeenCalled()
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/vaults' && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(postCall).toBeDefined()
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({ name: 'recipzz' })
  })

  it('sets aria-activedescendant to the active option, mirrored by aria-selected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNavFetch()
    renderOverlay(true)

    await search(user, 'recip')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    await user.keyboard('{ArrowDown}')

    const input = screen.getByPlaceholderText(/search/i)
    const activeId = input.getAttribute('aria-activedescendant')
    expect(activeId).toBeTruthy()

    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(1)
    options.forEach((opt) => {
      expect(opt).toHaveAttribute('aria-selected', opt.id === activeId ? 'true' : 'false')
    })

    expect(document.getElementById(activeId as string)).toHaveAccessibleName('Command: Open vault: Recipes')
  })

  it('gives the keyboard-active option a visible bg-muted class, and clears it off the others', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNavFetch()
    renderOverlay(true)

    await search(user, 'recip')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    await user.keyboard('{ArrowDown}')

    const options = screen.getAllByRole('option')
    const activeOption = options.find((o) => o.getAttribute('aria-selected') === 'true')
    expect(activeOption).toBeDefined()
    expect(activeOption).toHaveClass('bg-muted')
    for (const opt of options) {
      if (opt !== activeOption) expect(opt).not.toHaveClass('bg-muted')
    }
  })

  it('has no accessibility violations with an active option set via the keyboard', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNavFetch()
    const { container } = renderOverlay(true)

    await search(user, 'recip')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    await user.keyboard('{ArrowDown}')

    await expectNoA11yViolations(container)
  })
})

describe('SearchOverlay scope and filters', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function stubScopeFetch(fixture: unknown[] = FIXTURE) {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/vaults/') && url.includes('/search')) {
        return Promise.resolve(mockJsonResponse(200, fixture))
      }
      if (url.startsWith('/api/search')) return Promise.resolve(mockJsonResponse(200, fixture))
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, VAULTS))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('scopes the query to the vault named in the URL, and hitting Everywhere switches route and URL', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchMock = stubScopeFetch()
    const { router } = renderOverlay(true, '/?vault=v2')

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Recipes' })).toHaveAttribute('aria-checked', 'true'))
    await search(user, 'jane')

    await waitFor(() => {
      const searchCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/search?'))
      expect(searchCall?.[0]).toMatch(/^\/api\/vaults\/v2\/search\?/)
    })

    fetchMock.mockClear()
    await user.click(screen.getByRole('radio', { name: 'Everywhere' }))

    await waitFor(() => {
      const searchCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/search?'))
      expect(searchCall?.[0]).toMatch(/^\/api\/search\?/)
    })
    expect(router.state.location.search).not.toContain('vault')
  })

  it('reads the types filter from the URL and threads it into the search query even with the panel closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchMock = stubScopeFetch()
    // s_types, not types: the overlay's filter panel is namespaced
    // separately from the graph's own ?types= so the two never collide.
    renderOverlay(true, '/?s_types=people')

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    const searchCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/search'))
    expect(searchCall?.[0]).toContain('types=people')
    // The collapsed toggle still shows that one filter is active.
    expect(screen.getByRole('button', { name: 'Filters · 1' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('checking a tag checkbox behind the Filters toggle writes s_tags= into the URL (never the graph-owned tags=) and refetches with it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchMock = stubScopeFetch()
    const { router } = renderOverlay(true)

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    fetchMock.mockClear()

    await user.click(screen.getByRole('button', { name: 'Filters' }))
    await user.click(screen.getByRole('checkbox', { name: 'engineering' }))

    await waitFor(() => expect(router.state.location.search).toContain('s_tags=engineering'))
    expect(router.state.location.search).not.toMatch(/(?<!s_)tags=/)
    await waitFor(() => {
      const searchCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/search'))
      expect(searchCall?.[0]).toContain('tags=engineering')
    })
  })

  it('does not let the graph-owned ?types=/?tags= leak into the overlay filter panel', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchMock = stubScopeFetch()
    renderOverlay(true, '/?types=people&tags=engineering')

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    const searchCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/search'))
    expect(searchCall?.[0]).not.toContain('types=')
    expect(searchCall?.[0]).not.toContain('tags=')
  })

  it('has no accessibility violations with the scope control and filter panel both rendered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubScopeFetch()
    const { container } = renderOverlay(true)

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'engineering' })).toBeInTheDocument())

    await expectNoA11yViolations(container)
  })
})

/**
 * The connect flow's only other host is RepositoryPage, at `/repos/:id/files/*`,
 * and the only way to that route is the `Open repository:` rows above —
 * which are built from the repositories you already have. So the fixture here
 * is deliberately zero repositories: with one, this proves nothing.
 */
describe('SearchOverlay connect-repository command', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const CONNECTED = {
    id: 'r7',
    name: 'chapters',
    ownerId: 'u1',
    ingestionMethod: 'git',
    gitUrl: 'https://github.com/PIIIX-org/chapters.git',
    localPath: null,
    defaultBranch: null,
    mergeable: true,
    syncStatus: 'idle',
    lastSyncedAt: null,
    lastSyncError: null,
    lastWebhookAt: null,
    webhookConfigured: false,
    createdAt: '2026-08-25T09:00:00.000Z',
  }

  function stubNoRepositories() {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/search')) return Promise.resolve(mockJsonResponse(200, []))
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, []))
      if (url === '/api/repositories') {
        return Promise.resolve(
          init?.method === 'POST' ? mockJsonResponse(200, CONNECTED) : mockJsonResponse(200, []),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('offers the command with no repositories at all, and opens the connect form', async () => {
    stubNoRepositories()
    const { onClose } = renderOverlay(true)

    // No `Open repository: …` row exists to reach the page that used to be
    // the dialog's only host — this command is the whole route in.
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Connect a repository' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('option', { name: /Command: Open repository/ })).toBeNull()

    await userEvent.click(screen.getByRole('option', { name: 'Command: Connect a repository' }))

    expect(await screen.findByLabelText('Repository name')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Git remote' })).toBeInTheDocument()
    // ⌘K gets out of the way; the dialog is a modal over whatever is behind it.
    expect(onClose).toHaveBeenCalled()
  })

  it('lands in the new repository’s viewer once it is connected', async () => {
    stubNoRepositories()
    const { router } = renderOverlay(true)

    await userEvent.click(
      await screen.findByRole('option', { name: 'Command: Connect a repository' }),
    )
    await userEvent.type(await screen.findByLabelText('Repository name'), 'chapters')
    await userEvent.type(
      screen.getByLabelText('Git remote URL'),
      'https://github.com/PIIIX-org/chapters.git',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Connect repository' }))

    // The id comes from the response, not from anything typed — a hardcoded
    // path would have to guess 'r7'.
    await waitFor(() => expect(router.state.location.pathname).toBe('/repos/r7/files'))
  })
})
