import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../lib/api'
import { expectNoA11yViolations } from '../test/axe'
import { HomePage } from './HomePage'
import homePageSource from './HomePage.tsx?raw'

const SESSION = { id: 'u1', email: 'taha@piiix.org', status: 'active', role: 'member', createdAt: '2026-01-01' }
const VAULT = { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' }

function stubFetch(vaults: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, vaults))
      return Promise.resolve(mockJsonResponse(200, SESSION))
    }),
  )
}

function renderHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('HomePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the vault-creation empty state when there are no vaults, never the graph', async () => {
    stubFetch([])
    renderHome()

    expect(await screen.findByRole('heading', { name: 'Your graph is empty' })).toBeInTheDocument()
    expect(screen.getByLabelText('Vault name')).toBeInTheDocument()
    expect(screen.queryByTestId('graph-canvas')).toBeNull()
  })

  it('shows the loading skeleton first, then lazy-loads the graph canvas once a vault exists', async () => {
    stubFetch([VAULT])
    renderHome()

    // The skeleton's loading announcement must be present on first commit —
    // if GraphCanvas were imported statically instead of via lazy(), the
    // Suspense fallback would never commit and this assertion would fail.
    expect(screen.getByRole('status')).toHaveTextContent('Loading the graph')
    expect(screen.queryByTestId('graph-canvas')).toBeNull()

    expect(await screen.findByTestId('graph-canvas')).toBeInTheDocument()
  })

  it('loads the graph renderer via lazy(), never a static import of GraphCanvas', () => {
    // A static top-level import (`import GraphCanvas from '.../GraphCanvas.js'`)
    // would make GraphCanvas.tsx part of the initial bundle graph — the whole
    // point of the code-split boundary (spec decision 9) would be lost even
    // though the two runtime tests above still pass, since GraphCanvas is a
    // trivial stub that resolves fast enough either way to fake the loading
    // beat. This reads the source directly so that regression is caught here
    // rather than only downstream, in task 9's bundle-size check.
    const staticImport = /^import\s+GraphCanvas\b/m
    const lazyImport = /\blazy\(\s*\(\)\s*=>\s*import\(\s*['"]\.\.\/components\/graph\/GraphCanvas\.js['"]\s*\)\s*\)/

    expect(homePageSource).not.toMatch(staticImport)
    expect(homePageSource).toMatch(lazyImport)
  })

  it('renders the skeleton, not the empty state, while the vaults query is still pending', () => {
    // Never resolves within this test — vaults.isPending stays true.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})))
    renderHome()

    expect(screen.getByRole('status')).toHaveTextContent('Loading the graph')
    expect(screen.queryByRole('heading', { name: 'Your graph is empty' })).toBeNull()
  })

  it('still resolves the vault note-editor route through router.tsx', async () => {
    const { router } = await import('../router.js')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, [VAULT]))
        if (url.endsWith('/tree')) return Promise.resolve(mockJsonResponse(200, {}))
        if (url === '/api/vaults/v1/notes/foo') {
          return Promise.resolve(mockJsonResponse(200, { path: 'foo', frontmatter: {}, body: 'Foo body' }))
        }
        return Promise.resolve(mockJsonResponse(200, SESSION))
      }),
    )
    const memoryRouter = createMemoryRouter(router.routes, { initialEntries: ['/vaults/v1/notes/foo'] })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={memoryRouter} />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    expect(document.querySelector('.cm-content')!.textContent).toContain('Foo body')
  })

  it('has no accessibility violations in the empty-state branch', async () => {
    stubFetch([])
    const { container } = renderHome()
    await screen.findByRole('heading', { name: 'Your graph is empty' })

    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations in the graph branch', async () => {
    stubFetch([VAULT])
    const { container } = renderHome()
    await screen.findByTestId('graph-canvas')

    await expectNoA11yViolations(container)
  })
})
