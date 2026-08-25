import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { InstanceActivity } from './InstanceActivity.js'

function securityEvent(i: number) {
  return {
    id: `e${i}`,
    type: 'login_failed',
    actorUserId: null,
    subjectUserId: null,
    mcpConnectionId: null,
    ip: '10.0.0.1',
    detail: { email: 'someone@example.com' },
    createdAt: '2026-08-01T00:00:00.000Z',
  }
}

const AUDIT = [
  {
    id: 'r1',
    notePath: 'docs/secret',
    vaultId: 'v1',
    actorType: 'user',
    actorId: 'u1',
    action: 'update',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
]

// A full page of security events (the pager infers "there is more" from a full
// page) and a single audit row (so its Older button must be disabled).
function fetchMock() {
  return vi.fn().mockImplementation((url: string) => {
    if (url.startsWith('/api/admin/security-events')) {
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset'))
      return Promise.resolve(
        mockJsonResponse(200, offset === 0 ? Array.from({ length: 50 }, (_, i) => securityEvent(i)) : [securityEvent(99)]),
      )
    }
    if (url.startsWith('/api/admin/audit-trail')) return Promise.resolve(mockJsonResponse(200, AUDIT))
    return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
  })
}

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('InstanceActivity', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows who changed which note, never the change itself', async () => {
    vi.stubGlobal('fetch', fetchMock())
    const { container } = renderWithClient(<InstanceActivity />)

    expect(await screen.findByText('docs/secret')).toBeInTheDocument()
    expect(screen.getByText('by user')).toBeInTheDocument()
    // The spec's boundary, stated on screen rather than merely not violated.
    expect(container.textContent).toContain('Never what the change said')

    await expectNoA11yViolations(container)
  })

  it('pages the security log forward and back, bounded at both ends', async () => {
    const fetch = fetchMock()
    vi.stubGlobal('fetch', fetch)
    renderWithClient(<InstanceActivity />)

    const newer = await screen.findByRole('button', { name: 'Newer security events' })
    const older = screen.getByRole('button', { name: 'Older security events' })

    // At the top of the log there is nothing newer; a full page means there is
    // something older.
    expect(newer).toBeDisabled()
    await waitFor(() => expect(older).toBeEnabled())

    await userEvent.click(older)
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/security-events?limit=50&offset=50',
        expect.anything(),
      ),
    )
    // The second page came back short, so it is the last one.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Older security events' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Newer security events' })).toBeEnabled()
  })

  it('the audit pager is bounded by its own page, not the security log\'s', async () => {
    vi.stubGlobal('fetch', fetchMock())
    renderWithClient(<InstanceActivity />)

    // One audit row back means no next page, while the security log's full
    // page means there is one — the two feeds page independently.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Older security events' })).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Older audit entries' })).toBeDisabled()
  })
})
