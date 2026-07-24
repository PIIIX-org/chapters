import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import type { Vault } from '../../api/vaults'
import { NoteView } from './NoteView'

const EDIT_VAULT: Vault = { id: 'v1', name: 'V1', ownerId: 'u1', mergeable: false, access: 'edit' }
const READ_VAULT: Vault = { id: 'v1', name: 'V1', ownerId: 'u1', mergeable: false, access: 'read' }

// No default: passing `undefined` must stay undefined (a value default would
// swallow it), so the unknown-access → read-only path can be tested for real.
function renderNote(initialPath: string, vault: Vault | undefined) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/vaults/:vaultId',
        element: <Outlet context={vault} />,
        children: [{ path: 'notes/*', element: <NoteView /> }],
      },
    ],
    { initialEntries: [initialPath] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function putCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
}

describe('NoteView', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders the frontmatter and an editable CodeMirror body (edit access)', async () => {
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

    renderNote('/vaults/v1/notes/people/jane', EDIT_VAULT)

    await waitFor(() => expect(screen.getByText('type:')).toBeInTheDocument())
    const content = document.querySelector('.cm-content')
    expect(content).not.toBeNull()
    expect(content!.textContent).toContain('# Jane')
    expect(content!.textContent).toContain('Notes about Jane.')
    expect(content!.getAttribute('contenteditable')).toBe('true')
  })

  it('debounce-saves an edit to PUT /api/vaults/:id/notes/:path (edit access)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT')
        return Promise.resolve(mockJsonResponse(200, { id: 'n1', path: 'people/jane', frontmatter: {}, body: 'edited', updatedAt: '2026-01-02' }))
      return Promise.resolve(
        mockJsonResponse(200, { path: 'people/jane', frontmatter: {}, body: 'original', updatedAt: '2026-01-01' }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    renderNote('/vaults/v1/notes/people/jane', EDIT_VAULT)
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } })

    await vi.advanceTimersByTimeAsync(800)
    expect(putCalls(fetchMock)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(700)
    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/notes/people/jane',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ body: 'edited' }) }),
    )
  })

  it('read-only access: editor is non-editable and never saves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return Promise.resolve(mockJsonResponse(200, {}))
      return Promise.resolve(
        mockJsonResponse(200, { path: 'people/jane', frontmatter: { type: 'people' }, body: 'original', updatedAt: '2026-01-01' }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    renderNote('/vaults/v1/notes/people/jane', READ_VAULT)
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

    expect(document.querySelector('.cm-content')!.getAttribute('contenteditable')).toBe('false')
    expect(screen.getByText(/read-only/i)).toBeInTheDocument()

    // Even a programmatic change (readOnly does not block dispatch) must not save.
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'hacked' } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(putCalls(fetchMock)).toHaveLength(0)
  })

  it('locks the editor when vault access is unknown (undefined)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { path: 'people/jane', frontmatter: { type: 'people' }, body: 'original', updatedAt: '2026-01-01' }),
      ),
    )

    // No vault in outlet context → access unknown → conservative read-only lock.
    renderNote('/vaults/v1/notes/people/jane', undefined)
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())

    expect(document.querySelector('.cm-content')!.getAttribute('contenteditable')).toBe('false')
    expect(screen.getByText(/read-only/i)).toBeInTheDocument()
  })

  it('shows a not-found message for a missing note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(404, { error: 'note not found' })))

    renderNote('/vaults/v1/notes/people/ghost', EDIT_VAULT)

    await waitFor(() => expect(screen.getByText('Note not found.')).toBeInTheDocument())
  })
})
