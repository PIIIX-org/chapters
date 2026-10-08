import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { AppShell } from './AppShell.js'
import { ContextPanel, Inspector } from './ShellPanels.js'
import { useShellBreadcrumb, useShellStatus } from './shell-context.js'

function stubFetch(role: 'member' | 'admin' = 'member') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, []))
      if (url === '/api/logout') return Promise.resolve(mockJsonResponse(200, { status: 'logged_out' }))
      if (url.startsWith('/api/notifications')) return Promise.resolve(mockJsonResponse(200, []))
      if (url === '/api/me') {
        return Promise.resolve(
          mockJsonResponse(200, {
            id: 'u1',
            email: 'taha@piiix.org',
            status: 'active',
            role,
            createdAt: '2026-01-01',
            mfaEnabledAt: null,
            mfaRequired: false,
          }),
        )
      }
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    }),
  )
}

function TestConsumer({ hasPanels = false }: { hasPanels?: boolean }) {
  useShellBreadcrumb([{ label: 'Vaults', to: '/vaults' }, { label: 'Engineering Notes' }])
  useShellStatus({ tone: 'live', label: 'Synced' })

  return (
    <>
      {hasPanels && (
        <>
          <ContextPanel label="Files">
            <p>File tree content</p>
          </ContextPanel>
          <Inspector label="Metadata">
            <p>Metadata inspector</p>
          </Inspector>
        </>
      )}
      <div>
        <p>Main content area</p>
      </div>
    </>
  )
}

function renderMobileShell(initialRoute = '/', hasPanels = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <AppShell>
          <TestConsumer hasPanels={hasPanels} />
        </AppShell>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Mobile Navigation (MobileHeader & MobileTabBar)', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders MobileHeader with current breadcrumb title and status pill', async () => {
    stubFetch()
    renderMobileShell('/vaults/v1')

    const header = screen.getByLabelText('Mobile header')
    expect(header).toBeInTheDocument()
    expect(within(header).getByText('Engineering Notes')).toBeInTheDocument()
    expect(within(header).getByText('Synced')).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Search' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Universal new item' })).toBeInTheDocument()
  })

  it('renders MobileTabBar with primary 5 tabs and active indicator', async () => {
    stubFetch('member')
    renderMobileShell('/')

    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' })
    expect(nav).toBeInTheDocument()

    for (const label of ['Graph', 'Vaults', 'Repos', 'Team', 'Settings']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument()
    }

    const graphLink = within(nav).getByRole('link', { name: 'Graph' })
    expect(graphLink).toHaveAttribute('aria-current', 'page')

    const vaultsLink = within(nav).getByRole('link', { name: 'Vaults' })
    expect(vaultsLink).not.toHaveAttribute('aria-current')
  })

  it('renders Admin tab for admin role in MobileTabBar', async () => {
    stubFetch('admin')
    renderMobileShell('/')

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/me', expect.anything()))
    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' })
    expect(await within(nav).findByRole('link', { name: 'Admin' })).toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'Team' })).toBeNull()
  })

  it('renders panel toggle buttons in MobileHeader when panels are mounted and toggles panels', async () => {
    stubFetch()
    renderMobileShell('/vaults/v1', true)
    const user = userEvent.setup()

    const contextToggle = screen.getByRole('button', { name: 'Toggle mobile context panel' })
    const inspectorToggle = screen.getByRole('button', { name: 'Toggle mobile inspector' })

    expect(contextToggle).toBeInTheDocument()
    expect(inspectorToggle).toBeInTheDocument()

    // Context panel initially closed in mobile/viewport default or open, let's toggle
    const initialContextPressed = contextToggle.getAttribute('aria-pressed') === 'true'
    await user.click(contextToggle)
    expect(contextToggle).toHaveAttribute('aria-pressed', String(!initialContextPressed))

    // Inspector toggle
    const initialInspectorPressed = inspectorToggle.getAttribute('aria-pressed') === 'true'
    await user.click(inspectorToggle)
    expect(inspectorToggle).toHaveAttribute('aria-pressed', String(!initialInspectorPressed))
  })

  it('has zero accessibility violations in mobile navigation view', async () => {
    stubFetch()
    const { container } = renderMobileShell('/vaults/v1', true)
    await expectNoA11yViolations(container)
  })
})
