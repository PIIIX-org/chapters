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
    expect(screen.getByText('Git')).toBeInTheDocument()
    expect(screen.getByText('Synced')).toBeInTheDocument()
    expect(screen.getByText('Agent push')).toBeInTheDocument()
    expect(screen.getByText('Never synced')).toBeInTheDocument()
    expect(screen.getByText('Viewer')).toBeInTheDocument()
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
