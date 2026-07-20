import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { FileTree } from './FileTree'
import type { VaultTree } from '../../api/notes'

function renderTree(tree: VaultTree) {
  const router = createMemoryRouter([{ path: '/', element: <FileTree vaultId="v1" tree={tree} /> }])
  render(<RouterProvider router={router} />)
}

describe('FileTree', () => {
  it('groups notes by type and links each one to its note path', () => {
    renderTree({
      people: [
        { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' },
      ],
      projects: [
        { id: 'n2', path: 'projects/roadmap', type: 'projects', name: 'roadmap', frontmatter: {}, updatedAt: '2026-01-01' },
      ],
    })

    expect(screen.getByText('people')).toBeInTheDocument()
    expect(screen.getByText('projects')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'jane' })
    expect(link).toHaveAttribute('href', '/vaults/v1/notes/people/jane')
  })

  it('renders nothing but the container when the tree is empty', () => {
    renderTree({})
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
