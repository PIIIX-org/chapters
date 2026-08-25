import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { TrashedNote } from '../../api/notes.js'
import { NoteTrashPanel } from './NoteTrashPanel.js'

// Two rows, and every field differs between them: a panel that renders the
// first row's path, type or date for both — or a Restore handler bound to a
// hardcoded id — cannot pass against this fixture.
const TRASHED: TrashedNote[] = [
  {
    id: 'n1',
    path: 'people/ada.md',
    type: 'person',
    name: 'ada',
    deletedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'n2',
    path: 'projects/kiln.md',
    type: 'project',
    name: 'kiln',
    deletedAt: '2026-08-14T00:00:00.000Z',
  },
]

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('NoteTrashPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders each trashed note with its own path, type and deletion date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, TRASHED)))
    const { container } = renderWithClient(<NoteTrashPanel vaultId="v1" />)

    const adaRow = (await screen.findByText('people/ada.md')).closest('li')!
    const kilnRow = screen.getByText('projects/kiln.md').closest('li')!

    expect(adaRow.textContent).toContain('person')
    expect(adaRow.textContent).toContain('1 August 2026')
    expect(kilnRow.textContent).toContain('project')
    expect(kilnRow.textContent).toContain('14 August 2026')
    // The load-bearing half: the dates are per-row, not one date reused.
    expect(adaRow.textContent).not.toContain('14 August 2026')

    await expectNoA11yViolations(container)
  })

  it('restores the row that was clicked, by id, and not the other row', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(mockJsonResponse(200, { id: 'n2', path: 'projects/kiln.md' }))
      }
      return Promise.resolve(mockJsonResponse(200, TRASHED))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithClient(<NoteTrashPanel vaultId="v1" />)

    await userEvent.click(await screen.findByRole('button', { name: 'Restore projects/kiln.md' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/vaults/v1/trash/n2/restore',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/vaults/v1/trash/n1/restore', expect.anything())
  })

  it('explains what trash is rather than only saying it is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, [])))
    renderWithClient(<NoteTrashPanel vaultId="v1" />)

    const empty = await screen.findByText(/Nothing deleted/)
    expect(empty).toHaveTextContent(/moves it here instead of destroying it/)
    expect(empty).toHaveTextContent(/until the whole vault is purged/)
  })

  it('surfaces a failed load as an alert instead of showing an empty trash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(403, { error: 'edit access required' })))
    renderWithClient(<NoteTrashPanel vaultId="v1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('edit access required')
    expect(screen.queryByText(/Nothing deleted/)).not.toBeInTheDocument()
  })
})
