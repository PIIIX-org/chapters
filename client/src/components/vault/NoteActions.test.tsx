import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import type { NoteSummary } from '../../api/notes'
import { NoteActions } from './NoteActions'

const NOTE: NoteSummary = { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' }

function renderActions(currentPath = '/vaults/v1/notes/other/thing') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/vaults/:vaultId/notes/*', element: <NoteActions vaultId="v1" note={NOTE} /> }],
    { initialEntries: [currentPath] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function calls(fetchMock: ReturnType<typeof vi.fn>, method: string) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method)
}

describe('NoteActions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renames a note via the inline form (POST notes-rename)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, { id: 'n1', path: 'people/jane-doe', type: 'people', name: 'jane-doe', frontmatter: {}, body: '', updatedAt: '2026-01-02' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: /rename jane/i }))
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'jane-doe' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/vaults/v1/notes-rename',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ from: 'people/jane', to: 'jane-doe' }) }),
      ),
    )
  })

  it('rejects an invalid rename slug before calling the server', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: /rename jane/i }))
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Jane Doe' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(screen.getByText(/name must be/i)).toBeInTheDocument()
    expect(calls(fetchMock, 'POST')).toHaveLength(0)
  })

  it('deletes a note after confirming (DELETE)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'trashed', id: 'n1' }))
    vi.stubGlobal('fetch', fetchMock)
    renderActions()

    fireEvent.click(screen.getByRole('button', { name: /delete jane/i }))
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v1/notes/people/jane', expect.objectContaining({ method: 'DELETE' })),
    )
  })
})
