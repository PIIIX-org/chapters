import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { VAULT_TRASH_QUERY_KEY } from '../../hooks/useVaults'
import type { Vault, TrashedVault } from '../../api/vaults'
import { VaultRowActions, VaultTrashSection } from './VaultActions'

// One owned, one read-only vault on purpose: a fixture with only owner
// vaults would let the access gate pass even if it never checked access.
const OWNED: Vault = { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' }
const READ_ONLY: Vault = { id: 'v2', name: 'Shared Notes', ownerId: 'u2', mergeable: true, access: 'read' }

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function calls(fetchMock: ReturnType<typeof vi.fn>, method: string) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method)
}

describe('VaultRowActions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows Rename and Delete for an owner vault, neither for a read-only vault', () => {
    vi.stubGlobal('fetch', vi.fn())
    renderWithClient(
      <>
        <VaultRowActions vault={OWNED} />
        <VaultRowActions vault={READ_ONLY} />
      </>,
    )

    expect(screen.getByRole('button', { name: /rename engineering/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete engineering/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /rename shared notes/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete shared notes/i })).not.toBeInTheDocument()
  })

  it('delete confirmation names the vault and states the shared-access and restore consequence', () => {
    vi.stubGlobal('fetch', vi.fn())
    renderWithClient(<VaultRowActions vault={OWNED} />)

    fireEvent.click(screen.getByRole('button', { name: /delete engineering/i }))

    const confirmText = screen.getByRole('button', { name: /move to trash/i }).parentElement?.parentElement?.textContent ?? ''
    expect(confirmText).toMatch(/Engineering/)
    expect(confirmText).toMatch(/shared with loses access/i)
    expect(confirmText).toMatch(/restore it from Trash/i)
  })

  it('Cancel on the delete confirmation calls fetch zero times and returns to idle', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<VaultRowActions vault={OWNED} />)

    fireEvent.click(screen.getByRole('button', { name: /delete engineering/i }))
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /delete engineering/i })).toBeInTheDocument()
  })

  it('Move to trash calls DELETE /api/vaults/v1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'trashed', id: 'v1' }))
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<VaultRowActions vault={OWNED} />)

    fireEvent.click(screen.getByRole('button', { name: /delete engineering/i }))
    fireEvent.click(screen.getByRole('button', { name: /move to trash/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v1', expect.objectContaining({ method: 'DELETE' })),
    )
  })

  it('renames via the inline form (PATCH)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { ...OWNED, name: 'Renamed' }))
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<VaultRowActions vault={OWNED} />)

    fireEvent.click(screen.getByRole('button', { name: /rename engineering/i }))
    fireEvent.change(screen.getByLabelText('New vault name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/vaults/v1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) }),
      ),
    )
  })

  it('rejects a blank name before calling the server', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<VaultRowActions vault={OWNED} />)

    fireEvent.click(screen.getByRole('button', { name: /rename engineering/i }))
    fireEvent.change(screen.getByLabelText('New vault name'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(calls(fetchMock, 'PATCH')).toHaveLength(0)
  })

  it('has no accessibility violations in the idle state', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { container } = renderWithClient(<VaultRowActions vault={OWNED} />)
    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations in the confirmDelete state', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { container } = renderWithClient(<VaultRowActions vault={OWNED} />)
    fireEvent.click(screen.getByRole('button', { name: /delete engineering/i }))
    await expectNoA11yViolations(container)
  })
})

describe('VaultTrashSection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists a trashed vault and restores it (POST)', async () => {
    const trashed: TrashedVault[] = [{ id: 'v3', name: 'Old Project', deletedAt: '2026-08-01T00:00:00.000Z' }]
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(mockJsonResponse(200, { ...OWNED, id: 'v3', name: 'Old Project' }))
      return Promise.resolve(mockJsonResponse(200, trashed))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<VaultTrashSection />)

    expect(await screen.findByText('Trash')).toBeInTheDocument()
    expect(screen.getByText('Old Project')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /restore old project/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v3/restore', expect.objectContaining({ method: 'POST' })),
    )
  })

  it('renders nothing when the trash is empty', async () => {
    // The previous version of this test asserted queryByText('Trash') was
    // absent inside waitFor, which is already true in the loading state on
    // the very first tick — it never actually waited for the fetch to
    // settle, so it passed identically whether the empty branch worked or
    // the component always rendered null. Checking "fetch was called" has
    // the same race (it's true before the promise even resolves), so we
    // wait on the query's own status instead — the one signal that is only
    // true once trash.data is actually the resolved empty array. The
    // sibling "lists a trashed vault" test above is the positive control
    // proving this component CAN render 'Trash'; together they show the
    // empty case is a real branch, not a no-op.
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <VaultTrashSection />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(queryClient.getQueryState(VAULT_TRASH_QUERY_KEY)?.status).toBe('success'))
    expect(container).toBeEmptyDOMElement()
  })
  it('states what is lost before purging, and purges only the row that was confirmed', async () => {
    // Two trashed vaults on purpose: one row cannot tell a working handler from
    // one that purges whatever it finds first.
    const trashed: TrashedVault[] = [
      { id: 'v3', name: 'Old Project', deletedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'v4', name: 'Scratch', deletedAt: '2026-08-02T00:00:00.000Z' },
    ]
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(mockJsonResponse(200, { status: 'purged' }))
      return Promise.resolve(mockJsonResponse(200, trashed))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = renderWithClient(<VaultTrashSection />)

    await screen.findByText('Scratch')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Scratch permanently' }))
    // The one new destructive surface in this unit — axe it in its open state,
    // where the confirm panel actually exists.
    await expectNoA11yViolations(container)

    // The consequence, not "Are you sure?" — and nothing sent yet.
    expect(screen.getByText(/including the ones already in the note trash/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/vaults/v4/purge', expect.anything())

    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v4/purge', expect.objectContaining({ method: 'POST' })),
    )
    expect(fetchMock).not.toHaveBeenCalledWith('/api/vaults/v3/purge', expect.anything())
  })

  it('cancelling leaves the vault in the trash', async () => {
    const trashed: TrashedVault[] = [{ id: 'v3', name: 'Old Project', deletedAt: '2026-08-01T00:00:00.000Z' }]
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(mockJsonResponse(200, { status: 'purged' }))
      return Promise.resolve(mockJsonResponse(200, trashed))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<VaultTrashSection />)

    await screen.findByText('Old Project')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Old Project permanently' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText(/including the ones already in the note trash/i)).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/vaults/v3/purge', expect.anything())
  })
  it('says the trash could not be loaded instead of silently vanishing', async () => {
    // Reading .data with no isError branch made a failed fetch look exactly
    // like an empty trash — and the delete copy four lines up promises the
    // trash is where the vault went.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(500, { error: 'boom' })),
    )
    renderWithClient(<VaultTrashSection />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load the trash/i)
  })
})
