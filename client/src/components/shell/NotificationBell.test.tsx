import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { NotificationBell } from './NotificationBell'

// Two unread rows on purpose: a "first unread" bug (mark-as-read closing
// over the wrong row) is only detectable with more than one unread row.
const NOTIFICATIONS = [
  { id: 'n1', recipientId: 'u1', type: 'mention', entityType: 'note', entityId: 'a', message: 'First message', readAt: null, createdAt: '2026-08-01T00:00:00.000Z' },
  { id: 'n2', recipientId: 'u1', type: 'mention', entityType: 'note', entityId: 'b', message: 'Second message', readAt: null, createdAt: '2026-08-02T00:00:00.000Z' },
  { id: 'n3', recipientId: 'u1', type: 'mention', entityType: 'note', entityId: 'c', message: 'Third message', readAt: '2026-08-03T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' },
]

function renderBell(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationBell />
    </QueryClientProvider>,
  )
}

describe('NotificationBell', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the unread count in the accessible name', async () => {
    renderBell(vi.fn().mockResolvedValue(mockJsonResponse(200, NOTIFICATIONS)))

    expect(await screen.findByRole('button', { name: /notifications, 2 unread/i })).toBeInTheDocument()
  })

  it('opens the drawer listing every row, and closes on a second click or an outside click', async () => {
    renderBell(vi.fn().mockResolvedValue(mockJsonResponse(200, NOTIFICATIONS)))
    const user = userEvent.setup()
    const bell = await screen.findByRole('button', { name: /notifications, 2 unread/i })

    await user.click(bell)
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument()
    expect(screen.getByText('First message')).toBeInTheDocument()
    expect(screen.getByText('Second message')).toBeInTheDocument()
    expect(screen.getByText('Third message')).toBeInTheDocument()

    await user.click(bell)
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.click(bell)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('marks the second unread row read via POST to its own id, and the badge updates after refetch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJsonResponse(200, NOTIFICATIONS))
      .mockResolvedValueOnce(mockJsonResponse(200, { status: 'read' }))
      .mockResolvedValueOnce(
        mockJsonResponse(200, [{ ...NOTIFICATIONS[0], readAt: null }, { ...NOTIFICATIONS[2] }]),
      )
    renderBell(fetchMock)
    const user = userEvent.setup()
    const bell = await screen.findByRole('button', { name: /notifications, 2 unread/i })
    await user.click(bell)

    const rows = screen.getAllByText(/message$/)
    expect(rows.length).toBeGreaterThan(0)
    const secondRow = screen.getByText('Second message').closest('li')
    expect(secondRow).not.toBeNull()
    const markReadButton = secondRow!.querySelector('button')
    expect(markReadButton).not.toBeNull()

    await user.click(markReadButton!)

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/notifications/n2/read', expect.objectContaining({ method: 'POST' })),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /notifications, 1 unread/i })).toBeInTheDocument())
  })

  it('shows an error alert with Retry on a failed fetch, never the empty state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(500, { error: 'boom' }))
    renderBell(fetchMock)
    const user = userEvent.setup()
    const bell = await screen.findByRole('button', { name: 'Notifications' })
    await user.click(bell)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/no notifications/i)).toBeNull()

    const retry = screen.getByRole('button', { name: /retry/i })
    await user.click(retry)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('shows the empty state with no rows and no alert', async () => {
    renderBell(vi.fn().mockResolvedValue(mockJsonResponse(200, [])))
    const user = userEvent.setup()
    const bell = await screen.findByRole('button', { name: 'Notifications' })
    await user.click(bell)

    expect(await screen.findByText('No notifications yet.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Escape closes the drawer and returns focus to the bell', async () => {
    renderBell(vi.fn().mockResolvedValue(mockJsonResponse(200, NOTIFICATIONS)))
    const user = userEvent.setup()
    const bell = await screen.findByRole('button', { name: /notifications, 2 unread/i })

    // Real click first so focus genuinely sits on the bell (a sibling of
    // the drawer panel, not a descendant) before a bare Escape is fired —
    // exactly the setup that catches an Escape handler bound to a node
    // that never has focus.
    await user.click(bell)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(bell)
  })

  it('has no accessibility violations with the drawer open, and never uses the accent token', async () => {
    const { container } = renderBell(vi.fn().mockResolvedValue(mockJsonResponse(200, NOTIFICATIONS)))
    const user = userEvent.setup()
    const bell = await screen.findByRole('button', { name: /notifications, 2 unread/i })
    await user.click(bell)
    await screen.findByText('First message')

    await expectNoA11yViolations(container)

    const offenders = Array.from(container.querySelectorAll('*')).filter((el) =>
      Array.from(el.classList).some((c) => c === 'bg-accent' || c.startsWith('hover:bg-accent')),
    )
    expect(offenders).toHaveLength(0)
  })
})
