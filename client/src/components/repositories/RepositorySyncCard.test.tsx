import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { AccessibleRepository, RepositoryFile } from '../../api/repositories.js'
import { RepositorySyncCard } from './RepositorySyncCard.js'

// A git repository and an agent-push one, differing on every axis this
// component branches on: method, webhook delivery, sync state. A list of one,
// or of two identical rows, could not tell "selected the right repository"
// from "rendered whatever came first".
const GIT: AccessibleRepository = {
  id: 'r1',
  name: 'chapters',
  ownerId: 'u1',
  ingestionMethod: 'git',
  gitUrl: 'https://github.com/PIIIX-org/chapters.git',
  localPath: null,
  defaultBranch: 'main',
  mergeable: true,
  syncStatus: 'idle',
  lastSyncedAt: null,
  lastSyncError: null,
  lastWebhookAt: null,
  webhookConfigured: false,
  createdAt: '2026-08-20T09:00:00.000Z',
  access: 'owner',
}

const AGENT: AccessibleRepository = {
  ...GIT,
  id: 'r2',
  name: 'agent-fed',
  ingestionMethod: 'agent_push',
  gitUrl: null,
  defaultBranch: null,
  lastSyncedAt: null,
  lastWebhookAt: null,
  access: 'viewer',
}

// The third ingestion method, and the one the copy used to lie about: a
// folder nothing on the server ever scans.
const LOCAL: AccessibleRepository = {
  ...GIT,
  id: 'r3',
  name: 'local-checkout',
  ingestionMethod: 'local_path',
  gitUrl: null,
  localPath: '/srv/repos/local-checkout',
  defaultBranch: null,
  lastSyncedAt: null,
  access: 'owner',
}

// Two files, two languages, two directories — a count of 2 that a hardcoded
// "1 file" or a dropped second row would fail.
const FILES: RepositoryFile[] = [
  { id: 'f1', path: 'server/src/app.ts', language: 'typescript', size: 4211, updatedAt: '2026-08-24T11:02:11.000Z' },
  { id: 'f2', path: 'scripts/seed.py', language: 'python', size: 902, updatedAt: '2026-08-24T11:02:12.000Z' },
]

function renderCard(
  repositories: AccessibleRepository[],
  files: RepositoryFile[] | { status: number; body: unknown },
  repositoryId = 'r1',
  listStatus?: { status: number; body: unknown },
) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/repositories') {
      return Promise.resolve(
        listStatus ? mockJsonResponse(listStatus.status, listStatus.body) : mockJsonResponse(200, repositories),
      )
    }
    if (url.endsWith('/files')) {
      return Promise.resolve(
        Array.isArray(files) ? mockJsonResponse(200, files) : mockJsonResponse(files.status, files.body),
      )
    }
    throw new Error(`unstubbed request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <RepositorySyncCard repositoryId={repositoryId} />
    </QueryClientProvider>,
  )
}

describe('RepositorySyncCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports never synced, with the next step for that ingestion method only', async () => {
    const { container } = renderCard([GIT, AGENT], [], 'r2')

    expect(await screen.findByText('Never synced')).toBeInTheDocument()
    // The agent-push repository is the one waiting on a human; the git one is not.
    expect(screen.getByText(/an agent holding a sync token pushes/)).toBeInTheDocument()
    expect(screen.queryByText(/first clone runs/)).toBeNull()
    // No webhook line at all: there is no git host here to deliver one.
    expect(screen.queryByText(/polling this remote/)).toBeNull()
    expect(screen.queryByText(/Webhook delivering/)).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('does not promise a folder scan that nothing on the server runs', async () => {
    const { container } = renderCard([GIT, LOCAL], [], 'r3')

    expect(await screen.findByText('Never synced')).toBeInTheDocument()
    expect(screen.getByText(/does not read connected folders yet/)).toBeInTheDocument()
    // The claim that shipped: a scan coming shortly, and nothing to do about
    // it. `startWatching` has no caller and the poller only selects git rows.
    expect(screen.queryByText(/scan of the folder runs/)).toBeNull()
    expect(screen.queryByText(/Nothing to do/)).toBeNull()
    // Still the never-synced words, not the synced-and-empty ones.
    expect(screen.queryByText('Synced, but nothing was indexed')).toBeNull()
    expect(screen.queryByText(/check the path, the branch/)).toBeNull()
    // No git host here, so no webhook line either way.
    expect(screen.queryByText(/polling this remote/)).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('keeps synced-and-empty apart from never synced', async () => {
    renderCard([{ ...GIT, lastSyncedAt: '2026-08-24T11:00:00.000Z' }, AGENT], [])

    expect(await screen.findByText('Synced, but nothing was indexed')).toBeInTheDocument()
    expect(screen.getByText(/check the path, the branch/)).toBeInTheDocument()
    expect(screen.queryByText('Never synced')).toBeNull()
  })

  it('counts the indexed files once a sync has landed', async () => {
    renderCard([{ ...GIT, lastSyncedAt: '2026-08-24T11:00:00.000Z' }, AGENT], FILES)

    expect(await screen.findByText('Synced — 2 files')).toBeInTheDocument()
    expect(screen.queryByText(/nothing was indexed/)).toBeNull()
  })

  it('shows the recorded reason a sync failed, and no file count beside it', async () => {
    renderCard(
      [
        {
          ...GIT,
          syncStatus: 'error',
          lastSyncedAt: '2026-08-24T11:00:00.000Z',
          lastSyncError: 'authentication failed for https://github.com/PIIIX-org/chapters.git',
        },
        AGENT,
      ],
      FILES,
    )

    expect(await screen.findByText('Last sync failed')).toBeInTheDocument()
    expect(
      screen.getByText('authentication failed for https://github.com/PIIIX-org/chapters.git'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^Synced/)).toBeNull()
  })

  it('says it is syncing rather than reporting the previous result as current', async () => {
    renderCard([{ ...GIT, syncStatus: 'syncing', lastSyncedAt: '2026-08-24T11:00:00.000Z' }, AGENT], FILES)

    expect(await screen.findByText('Syncing now')).toBeInTheDocument()
    expect(screen.queryByText('Synced — 2 files')).toBeNull()
  })

  it('names the webhook delivery when there is one, and the polling fallback when there is not', async () => {
    const { unmount } = renderCard([{ ...GIT, lastSyncedAt: '2026-08-24T11:00:00.000Z' }, AGENT], FILES)
    expect(await screen.findByText(/polling this remote/)).toBeInTheDocument()
    expect(screen.queryByText(/Webhook delivering/)).toBeNull()
    unmount()
    vi.unstubAllGlobals()

    renderCard(
      [{ ...GIT, lastSyncedAt: '2026-08-24T11:00:00.000Z', lastWebhookAt: '2026-08-24T11:00:05.000Z' }, AGENT],
      FILES,
    )
    expect(await screen.findByText(/Webhook delivering/)).toBeInTheDocument()
    expect(screen.queryByText(/polling this remote/)).toBeNull()
  })

  it('surfaces a failed repository read instead of rendering it as synced', async () => {
    renderCard([GIT, AGENT], FILES, 'r1', { status: 403, body: { error: 'not your repository' } })

    expect(await screen.findByRole('alert')).toHaveTextContent('not your repository')
    expect(screen.queryByText(/^Synced/)).toBeNull()
    expect(screen.queryByText('Never synced')).toBeNull()
  })

  it('calls an unreadable file list unknown, never zero', async () => {
    renderCard([{ ...GIT, lastSyncedAt: '2026-08-24T11:00:00.000Z' }, AGENT], {
      status: 500,
      body: { error: 'index unavailable' },
    })

    expect(await screen.findByText('Synced')).toBeInTheDocument()
    // The trap: an errored file query read as `[]` would say this.
    expect(screen.queryByText('Synced, but nothing was indexed')).toBeNull()
    expect(await screen.findByText('Could not count the indexed files.')).toBeInTheDocument()
  })
})
