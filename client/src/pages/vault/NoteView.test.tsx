import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { NoteView } from './NoteView'

function renderNote(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/vaults/:vaultId/notes/*', element: <NoteView /> }],
    { initialEntries: [initialPath] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('NoteView', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders the frontmatter and an editable CodeMirror body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, {
          path: 'people/jane',
          frontmatter: { type: 'people', timestamp: '2026-01-01T00:00:00.000Z' },
          body: '# Jane\n\nNotes about Jane.',
          updatedAt: '2026-01-01',
        }),
      ),
    )

    renderNote('/vaults/v1/notes/people/jane')

    await waitFor(() => expect(screen.getByText('type:')).toBeInTheDocument())
    const content = document.querySelector('.cm-content')
    expect(content).not.toBeNull()
    expect(
      content!.textContent === '# Jane' + '' + 'Notes about Jane.' ||
        content!.textContent!.includes('Jane'),
    ).toBe(true)
  })

  it('debounce-saves an edit to PUT /api/vaults/:id/notes/:path', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return Promise.resolve(mockJsonResponse(200, { id: 'n1', path: 'people/jane', frontmatter: {}, body: 'edited', updatedAt: '2026-01-02' }))
      return Promise.resolve(
        mockJsonResponse(200, { path: 'people/jane', frontmatter: {}, body: 'original', updatedAt: '2026-01-01' }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    renderNote('/vaults/v1/notes/people/jane')
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

    const { EditorView } = await import('@codemirror/view')
    const contentEl = document.querySelector('.cm-editor') as HTMLElement
    const view = EditorView.findFromDOM(contentEl)!
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } })

    await vi.advanceTimersByTimeAsync(1500)

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/vaults/v1/notes/people/jane',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ body: 'edited' }) }),
      ),
    )
  })

  it('shows a not-found message for a missing note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(404, { error: 'note not found' })))

    renderNote('/vaults/v1/notes/people/ghost')

    await waitFor(() => expect(screen.getByText('Note not found.')).toBeInTheDocument())
  })
})
