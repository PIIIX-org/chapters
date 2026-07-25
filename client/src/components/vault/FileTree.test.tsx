import { describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
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
})
