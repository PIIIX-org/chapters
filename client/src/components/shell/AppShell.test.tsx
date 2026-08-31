import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { AppShell } from './AppShell'
import { ContextPanel, Inspector } from './ShellPanels'
import { useShellBreadcrumb, useShellStatus } from './shell-context'

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

function PanelPage() {
  useShellBreadcrumb([{ label: 'Vaults', to: '/vaults' }, { label: 'Engineering' }])
  useShellStatus({ tone: 'live', label: 'Live' })
  return (
    <>
      <ContextPanel label="Notes">
        <p>Context content</p>
      </ContextPanel>
      <Inspector label="Details">
        <p>Inspector content</p>
      </Inspector>
      <input aria-label="Note title" />
      <div data-testid="canvas" />
    </>
  )
}

function renderShell(initialPath = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        element: <AppShell />,
        children: [
          { path: '/', element: <div data-testid="canvas" /> },
          { path: '/vaults', element: <div>Vaults page</div> },
          { path: '/vaults/v1', element: <PanelPage /> },
          { path: '/settings', element: <div>Settings page</div> },
        ],
      },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: [initialPath] },
  )
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('AppShell', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the rail with every area, marking the current one', async () => {
    stubFetch()
    renderShell()

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    for (const name of ['Graph', 'Vaults', 'Repositories', 'Team', 'Settings']) {
      expect(within(rail).getByRole('link', { name })).toBeInTheDocument()
    }
    expect(within(rail).getByRole('link', { name: 'Graph' })).toHaveAttribute('aria-current', 'page')
    expect(within(rail).getByRole('link', { name: 'Vaults' })).not.toHaveAttribute('aria-current')
    // Admin is a door only admins get; a member never sees it.
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/me', expect.anything()))
    expect(within(rail).queryByRole('link', { name: 'Admin' })).toBeNull()
    expect(screen.getByTestId('canvas')).toBeInTheDocument()
  })

  it('shows the Admin area to an admin', async () => {
    stubFetch('admin')
    renderShell()
    const rail = screen.getByRole('navigation', { name: 'Primary' })
    expect(await within(rail).findByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin')
  })

  it('opens the command palette from the top bar trigger', async () => {
    stubFetch()
    renderShell()
    const user = userEvent.setup()

    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open the command palette' }))
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })

  it('logs out from the account menu via /api/logout, landing on /login', async () => {
    stubFetch()
    renderShell()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Account menu' }))
    expect(await screen.findByText('taha@piiix.org')).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/logout', expect.objectContaining({ method: 'POST' })),
    )
    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument())
  })

  it('switches the theme from the account menu and remembers it', async () => {
    stubFetch()
    renderShell()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Account menu' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Light' }))

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem('chapters.theme')).toBe('light')
  })

  it('jumps between areas with g-chords, but never while typing', async () => {
    stubFetch()
    renderShell('/vaults/v1')
    const user = userEvent.setup()
    await screen.findByText('Context content')

    // Typing in a field: the chord belongs to the field.
    await user.click(screen.getByRole('textbox', { name: 'Note title' }))
    await user.keyboard('gs')
    expect(screen.queryByText('Settings page')).toBeNull()

    // Same keys with nothing focused: the shell hears them.
    await user.click(document.body)
    await user.keyboard('gs')
    expect(await screen.findByText('Settings page')).toBeInTheDocument()
  })

  it('renders page panels in the shell tracks and toggles them with [ and ]', async () => {
    stubFetch()
    renderShell('/vaults/v1')
    const user = userEvent.setup()

    const context = screen.getByRole('complementary', { name: 'Context panel' })
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    await waitFor(() => expect(within(context).getByText('Context content')).toBeInTheDocument())
    expect(within(inspector).getByText('Inspector content')).toBeInTheDocument()
    expect(context).toBeVisible()

    const toggle = screen.getByRole('button', { name: 'Toggle context panel' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    // fireEvent, not user.keyboard: '[' is a user-event descriptor character.
    fireEvent.keyDown(document.body, { key: '[' })
    expect(context).not.toBeVisible()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(localStorage.getItem('chapters.shell.context')).toBe('closed')

    await user.click(screen.getByRole('button', { name: 'Toggle inspector' }))
    expect(inspector).not.toBeVisible()
    fireEvent.keyDown(document.body, { key: ']' })
    expect(inspector).toBeVisible()
  })

  it('shows the page breadcrumb and status pill in the top bar', async () => {
    stubFetch()
    renderShell('/vaults/v1')

    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(await within(crumbs).findByRole('link', { name: 'Vaults' })).toHaveAttribute('href', '/vaults')
    expect(within(crumbs).getByText('Engineering')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('status')).toHaveTextContent('Live')
  })

  it('renders the notification bell inside the notifications slot', async () => {
    stubFetch()
    const { container } = renderShell()
    const slot = container.querySelector('[data-slot="notifications"]')
    expect(slot).toBeInTheDocument()
    expect(slot?.querySelector('button[aria-haspopup="dialog"]')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    stubFetch()
    const { container } = renderShell('/vaults/v1')
    await screen.findByText('Context content')
    await expectNoA11yViolations(container)
  })

  it('never uses the accent token for ordinary chrome (authorship colour is reserved)', async () => {
    stubFetch()
    const { container } = renderShell('/vaults/v1')
    await screen.findByText('Context content')

    const offenders = Array.from(container.querySelectorAll('*')).filter((el) =>
      Array.from(el.classList).some((c) => c === 'bg-accent' || c.startsWith('hover:bg-accent')),
    )
    expect(offenders).toHaveLength(0)
  })
})
