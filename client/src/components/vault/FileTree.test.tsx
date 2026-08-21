import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { FileTree } from './FileTree'
import type { VaultTree } from '../../api/notes'

function renderTree(tree: VaultTree, canEdit = false) {
  const router = createMemoryRouter([{ path: '/', element: <FileTree vaultId="v1" tree={tree} canEdit={canEdit} /> }])
  render(<RouterProvider router={router} />)
}

function renderTreeEditable(tree: VaultTree) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/vaults/:vaultId/notes/*', element: <FileTree vaultId="v1" tree={tree} canEdit /> }],
    { initialEntries: ['/vaults/v1/notes/people/jane'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('FileTree', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('groups notes by type and links each one to its note path', () => {
    renderTree(
      {
        people: [
          { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' },
        ],
        projects: [
          { id: 'n2', path: 'projects/roadmap', type: 'projects', name: 'roadmap', frontmatter: {}, updatedAt: '2026-01-01' },
        ],
      },
      false,
    )

    expect(screen.getByText('people')).toBeInTheDocument()
    expect(screen.getByText('projects')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'jane' })
    expect(link).toHaveAttribute('href', '/vaults/v1/notes/people/jane')
  })

  it('renders nothing but the container when the tree is empty', () => {
    renderTree({}, false)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('renders a note-actions control only when canEdit is true', () => {
    const tree: VaultTree = {
      people: [
        { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' },
      ],
    }

    renderTree(tree, false)
    expect(screen.queryByRole('button', { name: /rename jane/i })).not.toBeInTheDocument()
    cleanup()

    renderTreeEditable(tree)
    expect(screen.getByRole('button', { name: /rename jane/i })).toBeInTheDocument()
  })

  // Faithful to the real router topology: FileTree renders in VaultLayout's
  // sidebar (the PARENT /vaults/:vaultId route), while the `*` splat lives on
  // the CHILD notes/* route. This guards that NoteActions' `isOpen` check
  // (useParams()['*'] === note.path) actually resolves the open note's path at
  // the real mount point — renaming the open note must navigate the editor to
  // the new path, not leave it on the now-moved (404) path.
  it('renaming the currently-open note navigates the editor to the new path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { id: 'n1', path: 'people/jane-doe', type: 'people', name: 'jane-doe', frontmatter: {}, body: '', updatedAt: '2026-01-02' }),
      ),
    )
    const tree: VaultTree = {
      people: [{ id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' }],
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createMemoryRouter(
      [
        {
          path: '/vaults/:vaultId',
          element: (
            <>
              <FileTree vaultId="v1" tree={tree} canEdit />
              <Outlet />
            </>
          ),
          children: [{ path: 'notes/*', element: <div>note pane</div> }],
        },
      ],
      { initialEntries: ['/vaults/v1/notes/people/jane'] },
    )
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /rename jane/i }))
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'jane-doe' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/vaults/v1/notes/people/jane-doe'))
  })
})
