import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { AdminUser } from '../../api/admin.js'
import { ApprovalQueue } from './ApprovalQueue.js'

// Mixed on purpose: one who verified their email and one who did not. A
// fixture of two identical rows would let a queue that never renders the
// unverified warning pass.
const PENDING: AdminUser[] = [
  {
    id: 'u1',
    email: 'verified@example.com',
    status: 'pending_approval',
    role: 'member',
    emailVerifiedAt: '2026-08-02T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'u2',
    email: 'unverified@example.com',
    status: 'pending_approval',
    role: 'member',
    emailVerifiedAt: null,
    createdAt: '2026-08-03T00:00:00.000Z',
  },
]

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('ApprovalQueue', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('warns about the unverified account only, and never about the verified one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(200, PENDING)),
    )
    const { container } = renderWithClient(<ApprovalQueue />)

    const unverifiedRow = (await screen.findByText('unverified@example.com')).closest('tr')!
    const verifiedRow = screen.getByText('verified@example.com').closest('tr')!

    expect(unverifiedRow.textContent).toContain('Email not verified yet')
    // The load-bearing half: the warning must be per-row, not page-wide.
    expect(verifiedRow.textContent).not.toContain('Email not verified yet')

    await expectNoA11yViolations(container)
  })

  it('approves the row that was clicked, by id', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(mockJsonResponse(200, { status: 'active' }))
      return Promise.resolve(mockJsonResponse(200, PENDING))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<ApprovalQueue />)

    await userEvent.click(await screen.findByRole('button', { name: 'Approve unverified@example.com' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/users/u2/approve',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    // …and not the other row's.
    expect(fetchMock).not.toHaveBeenCalledWith('/api/admin/users/u1/approve', expect.anything())
  })

  it('says nobody is waiting rather than rendering an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, [])))
    renderWithClient(<ApprovalQueue />)
    expect(await screen.findByText(/Nobody is waiting/)).toBeInTheDocument()
  })

  it('surfaces a failed queue read instead of showing it as empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(403, { error: 'admin required' })),
    )
    renderWithClient(<ApprovalQueue />)
    expect(await screen.findByRole('alert')).toHaveTextContent('admin required')
    expect(screen.queryByText(/Nobody is waiting/)).not.toBeInTheDocument()
  })
})
