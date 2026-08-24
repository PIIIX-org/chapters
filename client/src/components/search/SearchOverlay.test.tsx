import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
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

function renderOverlay(open = true, initialEntry = '/') {
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/', element: <SearchOverlay open={open} onClose={onClose} /> }],
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
function stubFetch(search: () => Response) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.startsWith('/api/search')) return Promise.resolve(search())
    if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, []))
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

    // Note chips and score — scoped to the result option itself, since the
    // filter panel derives its own "engineering" tag checkbox from this same
    // result and would otherwise collide with a bare screen.getByText.
    const noteOption = screen.getByText('people/jane').closest('[role="option"]') as HTMLElement
    expect(within(noteOption).getByText('engineering')).toBeInTheDocument()
    expect(within(noteOption).getByText('0.91')).toBeInTheDocument()

    // The code entry's full snippet is not shown until expanded.
    expect(screen.queryByText('export function x() { return 1 }')).toBeNull()
  })

  it('clicking a note result navigates and closes the overlay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubFetch(() => mockJsonResponse(200, FIXTURE))
    const { onClose, router } = renderOverlay(true)

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    await user.click(screen.getByText('people/jane'))
    expect(router.state.location.pathname).toBe('/vaults/v1/notes/people/jane')
    expect(onClose).toHaveBeenCalled()
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
    const input = screen.getByPlaceholderText(/search/i)
    const panel = input.parentElement as HTMLElement
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
})

describe('SearchOverlay commands', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

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

  it('shows navigation commands on an empty query and never hits search', async () => {
    const fetchMock = stubCommandFetch()
    renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Open vault: Recipes' })).toBeInTheDocument(),
    )
    expect(screen.getByRole('option', { name: 'Command: Go to graph home' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Create vault/i })).toBeNull()

    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/search'))).toBe(false)
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

  it('clicking a vault command navigates to that vault and closes the overlay', async () => {
    stubCommandFetch()
    const { onClose, router } = renderOverlay(true)

    const option = await screen.findByRole('option', { name: 'Command: Open vault: Recipes' })
    await userEvent.click(option)

    expect(router.state.location.pathname).toBe('/vaults/v2')
    expect(onClose).toHaveBeenCalled()
  })

  it('creates a vault from the typed query and navigates to the returned id', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchMock = stubCommandFetch({
      createResponse: mockJsonResponse(200, { id: 'v9', name: 'Atlas', ownerId: 'u1', mergeable: true, access: 'owner' }),
    })
    const { onClose, router } = renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to graph home' })).toBeInTheDocument(),
    )
    await search(user, 'Atlas')

    const option = await screen.findByRole('option', { name: 'Command: Create vault "Atlas"' })
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
      expect(screen.getByRole('option', { name: 'Command: Go to graph home' })).toBeInTheDocument(),
    )
    await search(user, 'Atlas')

    const option = await screen.findByRole('option', { name: 'Command: Create vault "Atlas"' })
    await user.click(option)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByText('vault name already exists')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('never renders a command for a route that does not exist yet', async () => {
    stubCommandFetch()
    renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to graph home' })).toBeInTheDocument(),
    )
    // 'team' is deliberately excluded here — the Team page exists now and has
    // its own command, asserted in the "SearchOverlay team command" suite.
    expect(screen.queryByRole('option', { name: /settings|admin|invite/i })).toBeNull()
  })

  it('renders a "Go to team" command', async () => {
    stubCommandFetch()
    renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to team' })).toBeInTheDocument(),
    )
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
      expect(screen.getByRole('option', { name: 'Command: Go to graph home' })).toBeInTheDocument(),
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
      expect(screen.getByRole('option', { name: 'Command: Go to graph home' })).toBeInTheDocument(),
    )
    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    await expectNoA11yViolations(container)
  })
})

describe('SearchOverlay team command', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function stubTeamFetch() {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/search')) return Promise.resolve(mockJsonResponse(200, []))
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, []))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('typing "team" surfaces "Go to team", and Enter on it navigates to /team', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubTeamFetch()
    const { onClose, router, container } = renderOverlay(true)

    await search(user, 'team')
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to team' })).toBeInTheDocument(),
    )
    await expectNoA11yViolations(container)

    // Driven from the real input, same as the other nav-command activations:
    // Enter fires on whatever the flat list's activeIndex currently is.
    await user.keyboard('{Enter}')

    expect(router.state.location.pathname).toBe('/team')
    expect(onClose).toHaveBeenCalled()
  })

  it('a query that cannot match "team" leaves no "Go to team" option', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubTeamFetch()
    renderOverlay(true)

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Go to graph home' })).toBeInTheDocument(),
    )
    await search(user, 'zzz')

    expect(screen.queryByRole('option', { name: 'Command: Go to team' })).toBeNull()
  })
})

describe('SearchOverlay keyboard navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // Two vaults (not one) so a "picks the first" bug can't pass, and a query
  // ('e') that every nav-command label matches, so the flat entry list is
  // commands [home, vault:Engineering, vault:Recipes, create-vault] followed
  // by results [note, code] — six entries with distinct destinations.
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
          mockJsonResponse(200, { id: 'v9', name: 'ezz', ownerId: 'u1', mergeable: true, access: 'owner' }),
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

    await search(user, 'e')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1)

    // Entry 0 is "Go to graph home" (-> '/'); entry 1 is "Open vault:
    // Engineering" (-> '/vaults/v1'). Only the second proves the arrow key
    // moved the index at all.
    await user.keyboard('{ArrowDown}{Enter}')

    expect(router.state.location.pathname).toBe('/vaults/v1')
    expect(onClose).toHaveBeenCalled()
  })

  it('ArrowUp as the first keystroke wraps to the last entry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNavFetch()
    const { onClose, router } = renderOverlay(true)

    await search(user, 'e')
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
    const fetchMock = stubNavFetch({ searchByQuery: (q) => (q === 'ezz' ? [] : FIXTURE) })
    const { onClose, router } = renderOverlay(true)

    await search(user, 'e')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    // Wrap straight to the last entry, then narrow the query so both the
    // command filter and the result set shrink to a single survivor: the
    // synthesized "create vault" command.
    await user.keyboard('{ArrowUp}')
    await search(user, 'zz')
    await waitFor(() => expect(screen.queryByText('people/jane')).toBeNull())
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Command: Create vault "ezz"' })).toBeInTheDocument(),
    )
    expect(screen.getAllByRole('option')).toHaveLength(1)

    await user.keyboard('{Enter}')

    await waitFor(() => expect(router.state.location.pathname).toBe('/vaults/v9'))
    expect(onClose).toHaveBeenCalled()
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/vaults' && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(postCall).toBeDefined()
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({ name: 'ezz' })
  })

  it('sets aria-activedescendant to the active option, mirrored by aria-selected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNavFetch()
    renderOverlay(true)

    await search(user, 'e')
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

    expect(document.getElementById(activeId as string)).toHaveAccessibleName('Command: Open vault: Engineering')
  })

  it('gives the keyboard-active option a visible bg-muted class, and clears it off the others', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubNavFetch()
    renderOverlay(true)

    await search(user, 'e')
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

    await search(user, 'e')
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

  const VAULTS = [
    { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' as const },
    { id: 'v2', name: 'Recipes', ownerId: 'u1', mergeable: true, access: 'owner' as const },
  ]

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

  it('reads the types filter from the URL and threads it into the search query', async () => {
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
  })

  it('checking a tag checkbox writes s_tags= into the URL (never the graph-owned tags=) and refetches with it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const fetchMock = stubScopeFetch()
    const { router } = renderOverlay(true)

    await search(user, 'jane')
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    fetchMock.mockClear()

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

    await expectNoA11yViolations(container)
  })
})
