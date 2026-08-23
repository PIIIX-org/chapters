import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function renderOverlay(open = true) {
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/', element: <SearchOverlay open={open} onClose={onClose} /> }],
    { initialEntries: ['/'] },
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

    // Note chips and score.
    expect(screen.getByText('engineering')).toBeInTheDocument()
    expect(screen.getByText('0.91')).toBeInTheDocument()

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

    const codeButton = screen.getByText('src/x.ts').closest('button') as HTMLElement
    expect(codeButton).toHaveAttribute('aria-expanded', 'false')
    await user.click(codeButton)

    expect(router.state.location.pathname).toBe('/')
    expect(onClose).not.toHaveBeenCalled()
    expect(codeButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('export function x() { return 1 }')).toBeInTheDocument()
  })

  it('renders an alert with a retry button on search failure, never the empty state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    stubFetch(() => mockJsonResponse(500, { error: 'search backend unavailable' }))
    renderOverlay(true)

    await search(user, 'jane')

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByText('search backend unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByText(/no results/i)).toBeNull()
  })

  it('closes on Escape', () => {
    const { onClose } = renderOverlay(true)
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on a backdrop click but not on a click inside the panel', () => {
    const { onClose } = renderOverlay(true)
    const input = screen.getByPlaceholderText(/search/i)
    const panel = input.parentElement as HTMLElement
    const backdrop = panel.parentElement as HTMLElement

    // A mousedown inside the panel must NOT close.
    fireEvent.mouseDown(panel)
    expect(onClose).not.toHaveBeenCalled()

    // A mousedown on the backdrop itself closes.
    fireEvent.mouseDown(backdrop)
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
