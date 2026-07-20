import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getDefaultNormalizer, render, screen, waitFor } from '@testing-library/react'
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
  })

  it('renders the frontmatter and body of the selected note', async () => {
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

    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    expect(screen.getByText('type:')).toBeInTheDocument()
    expect(
      screen.getByText('# Jane\n\nNotes about Jane.', {
        normalizer: getDefaultNormalizer({ collapseWhitespace: false }),
      }),
    ).toBeInTheDocument()
  })

  it('shows a not-found message for a missing note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(404, { error: 'note not found' })))

    renderNote('/vaults/v1/notes/people/ghost')

    await waitFor(() => expect(screen.getByText('Note not found.')).toBeInTheDocument())
  })
})
