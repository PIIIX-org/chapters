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
    // CodeMirror renders each source line as its own .cm-line, so the body
    // text is split across children — assert both non-empty lines are present
    // rather than exact-matching a whitespace-collapsed textContent.
    expect(content!.textContent).toContain('# Jane')
    expect(content!.textContent).toContain('Notes about Jane.')
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

    const putCalls = () =>
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')

    // Still inside the ~1200ms debounce window — the save must NOT have fired
    // yet. (This assertion is what gives the test teeth: it fails if the
    // debounce is removed and the PUT fires immediately.)
    await vi.advanceTimersByTimeAsync(800)
    expect(putCalls()).toHaveLength(0)

    // Past the window — the debounced save fires exactly once, with the edit.
    await vi.advanceTimersByTimeAsync(700)
    await waitFor(() => expect(putCalls()).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/notes/people/jane',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ body: 'edited' }) }),
    )
  })

  it('shows a not-found message for a missing note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(404, { error: 'note not found' })))

    renderNote('/vaults/v1/notes/people/ghost')

    await waitFor(() => expect(screen.getByText('Note not found.')).toBeInTheDocument())
  })
})
