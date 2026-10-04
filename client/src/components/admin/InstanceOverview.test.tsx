import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { InstanceOverview } from './InstanceOverview.js'

// The server groups by status and only returns buckets that have rows, so a
// fresh instance has no 'deactivated' key at all. A fixture carrying all three
// would let a missing `?? 0` render "undefined" in production and pass here.
const STATS = {
  usersByStatus: [
    { status: 'active', count: 3 },
    { status: 'pending_approval', count: 1 },
  ],
  vaults: 4,
  teams: 2,
  notes: 120,
  storageBytes: 2_411_724,
  activeMcpConnections: 1,
}

const ADMIN_SESSION = {
  id: 'me',
  email: 'admin@example.com',
  status: 'active',
  role: 'admin',
  createdAt: '2026-08-01T00:00:00.000Z',
  mfaEnabledAt: null,
  mfaRequired: false,
}

// A fresh Response per call, branched by URL: this page now also renders the
// MFA-requirement toggle, which reads the session, and a Response body can
// only be read once — a single mockResolvedValue hands the second query an
// already-consumed body and the stats query resolves undefined.
function stubFetch() {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/me') return Promise.resolve(mockJsonResponse(200, ADMIN_SESSION))
    if (url.startsWith('/api/admin/stats')) return Promise.resolve(mockJsonResponse(200, STATS))
    return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('InstanceOverview', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports an absent status bucket as zero, not as nothing', async () => {
    stubFetch()
    const { container } = renderWithClient(<InstanceOverview />)

    // parentElement: StatTile wraps the label and the value in one tile div,
    // so the label's parent is the tile whose text carries the number.
    const deactivated = (await screen.findByText('Deactivated')).parentElement!
    expect(deactivated.textContent).toContain('0')
    expect(container.textContent).not.toContain('undefined')
    expect(container.textContent).not.toContain('NaN')

    expect(screen.getByText('Awaiting approval').parentElement!.textContent).toContain('1')
    // Bytes are unreadable at instance scale; 2.4 MB is the point of the tile.
    expect(screen.getByText('2.3 MB')).toBeInTheDocument()

    await expectNoA11yViolations(container)
  })

  it('offers the backup as a plain download link and names the CLI for restore', async () => {
    stubFetch()
    renderWithClient(<InstanceOverview />)

    // A link, not a button: the response is a zip, and apiFetch would try to
    // parse it as JSON.
    const link = screen.getByRole('link', { name: 'Download backup' })
    expect(link).toHaveAttribute('href', '/api/admin/backup')
    expect(link).toHaveAttribute('download')

    expect(screen.getByText('pnpm restore-backup')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /restore/i })).toBeNull()
  })

  it('renders configured automated backup details and triggers manual backup', async () => {
    let backupRunCalled = false
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/me') return Promise.resolve(mockJsonResponse(200, ADMIN_SESSION))
      if (url.startsWith('/api/admin/stats')) return Promise.resolve(mockJsonResponse(200, STATS))
      if (url === '/api/admin/backup/status') {
        return Promise.resolve(
          mockJsonResponse(200, {
            configured: true,
            destinations: ['local', 's3'],
            localPath: '/var/backups/elara',
            s3Bucket: 'my-elara-bucket',
            s3Prefix: 'elara-backups/',
            retentionCount: 5,
            intervalHours: 12,
            lastRunAt: '2026-09-27T10:00:00.000Z',
            lastStatus: 'success',
            lastError: null,
            lastFilename: 'elara-backup-2026-09-27.zip',
            lastSizeBytes: 5242880,
          }),
        )
      }
      if (url === '/api/admin/backup/run' && init?.method === 'POST') {
        backupRunCalled = true
        return Promise.resolve(
          mockJsonResponse(200, {
            success: true,
            result: {
              filename: 'elara-backup-2026-09-27T12-00-00.zip',
              sizeBytes: 5242880,
              destinations: ['local', 's3'],
              prunedCount: 1,
              completedAt: '2026-09-27T12:00:00.000Z',
            },
          }),
        )
      }
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container } = renderWithClient(<InstanceOverview />)

    expect(await screen.findByText('Configured')).toBeInTheDocument()
    expect(screen.getByText('/var/backups/elara')).toBeInTheDocument()
    expect(screen.getByText(/my-elara-bucket/)).toBeInTheDocument()
    expect(screen.getByText(/every 12h/)).toBeInTheDocument()

    const runButton = screen.getByRole('button', { name: 'Run backup now' })
    expect(runButton).toBeInTheDocument()
    runButton.click()

    expect(await screen.findByText(/Backup snapshot created successfully/)).toBeInTheDocument()
    expect(backupRunCalled).toBe(true)

    await expectNoA11yViolations(container)
  })

  it('renders sync error state when backup execution has failed', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/me') return Promise.resolve(mockJsonResponse(200, ADMIN_SESSION))
      if (url.startsWith('/api/admin/stats')) return Promise.resolve(mockJsonResponse(200, STATS))
      if (url === '/api/admin/backup/status') {
        return Promise.resolve(
          mockJsonResponse(200, {
            configured: true,
            destinations: ['s3'],
            s3Bucket: 'my-elara-bucket',
            retentionCount: 7,
            intervalHours: 24,
            lastRunAt: '2026-09-27T10:00:00.000Z',
            lastStatus: 'error',
            lastError: 'S3 upload failed (403 Forbidden): InvalidAccessKeyId',
            lastFilename: null,
            lastSizeBytes: null,
          }),
        )
      }
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container } = renderWithClient(<InstanceOverview />)

    expect(await screen.findByText('Sync Error')).toBeInTheDocument()
    expect(screen.getByText(/InvalidAccessKeyId/)).toBeInTheDocument()

    await expectNoA11yViolations(container)
  })
})

