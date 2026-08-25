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

    // parentElement, not closest('div'): the label is itself a div, so
    // closest would return the label and match nothing but its own text.
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
})
