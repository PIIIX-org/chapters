import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { mockJsonResponse } from '../lib/api'
import { expectNoA11yViolations } from '../test/axe'
import { ReposPage } from './ReposPage'

const REPOS = [
  {
    id: 'r1',
    name: 'Atlas ERP',
    ownerId: 'u1',
    ingestionMethod: 'git',
    gitUrl: 'https://github.com/acme/atlas',
    localPath: null,
    defaultBranch: 'main',
    mergeable: true,
    syncStatus: 'idle',
    lastSyncedAt: '2026-08-01T10:00:00.000Z',
    lastSyncError: null,
    lastWebhookAt: null,
    webhookConfigured: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    access: 'owner',
  },
  {
    id: 'r2',
    name: 'Docs site',
    ownerId: 'u2',
    ingestionMethod: 'agent_push',
    gitUrl: null,
    localPath: null,
    defaultBranch: null,
    mergeable: false,
    syncStatus: 'idle',
    lastSyncedAt: null,
    lastSyncError: null,
    lastWebhookAt: null,
    webhookConfigured: false,
    createdAt: '2026-07-02T00:00:00.000Z',
    access: 'viewer',
  },
]

function stubFetch(repos: unknown = REPOS, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/repositories') return Promise.resolve(mockJsonResponse(status, repos))
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    }),
  )
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/repos']}>
        <ReposPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ReposPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists repositories with their source, sync health and access', async () => {
    stubFetch()
    renderPage()

    expect(await screen.findByRole('link', { name: 'Atlas ERP' })).toHaveAttribute('href', '/repos/r1/files')
    expect(screen.getAllByText('Git').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Synced')).toBeInTheDocument()
    expect(screen.getAllByText('Agent push').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Never synced').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Viewer')).toBeInTheDocument()
  })

  it('toggles between card view and list view', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Atlas ERP' })
    expect(screen.queryByRole('table')).toBeNull()

    // Switch to list view
    await userEvent.click(screen.getByRole('button', { name: 'List view' }))
    expect(screen.getByRole('table')).toBeInTheDocument()

    // Switch back to card view
    await userEvent.click(screen.getByRole('button', { name: 'Card view' }))
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('filters repositories by search term', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Atlas ERP' })
    expect(screen.getByRole('link', { name: 'Docs site' })).toBeInTheDocument()

    const searchInput = screen.getByRole('textbox', { name: 'Search repositories' })
    await userEvent.type(searchInput, 'Atlas')

    expect(screen.getByRole('link', { name: 'Atlas ERP' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Docs site' })).toBeNull()
  })

  it('allows organizing a repository into a folder with custom color', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Atlas ERP' })
    const assignBtn = screen.getByRole('button', {
      name: 'Assign folder for Atlas ERP',
    })
    await userEvent.click(assignBtn)

    expect(await screen.findByRole('heading', { name: 'Organize Repository' })).toBeInTheDocument()

    const folderInput = screen.getByLabelText(/folder name/i)
    await userEvent.type(folderInput, 'Core Backend')

    // Open custom color picker
    const openColorBtn = screen.getByRole('button', {
      name: 'Open custom folder color picker',
    })
    await userEvent.click(openColorBtn)

    expect(await screen.findByRole('heading', { name: 'Folder Color' })).toBeInTheDocument()
    const hexInput = screen.getByLabelText(/hex code/i)
    await userEvent.clear(hexInput)
    await userEvent.type(hexInput, '#8b5cf6')

    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    // Save folder dialog
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    // Folder badge updated on repo card
    expect(
      await screen.findByRole('button', {
        name: 'Folder: Core Backend for Atlas ERP',
      }),
    ).toBeInTheDocument()
  })

  it('opens the connect dialog from the header', async () => {
    stubFetch([])
    renderPage()
    const user = userEvent.setup()
    expect(await screen.findByText('No repositories yet')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Connect a repository' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('shows an error state with retry', async () => {
    stubFetch({ error: 'boom' }, 500)
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t load your repositories.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    stubFetch()
    const { container } = renderPage()
    await screen.findByRole('link', { name: 'Atlas ERP' })
    await expectNoA11yViolations(container)
  })
})
