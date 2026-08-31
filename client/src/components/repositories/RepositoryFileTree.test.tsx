import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { RepositoryFile } from '../../api/repositories.js'
import { RepositoryFileTree } from './RepositoryFileTree.js'

function file(path: string): RepositoryFile {
  return { id: `id:${path}`, path, language: null, size: 1, updatedAt: '2026-08-24T11:00:00.000Z' }
}

// Two top-level folders (one nested two deep), plus a root file — enough to
// tell "top level open, deeper levels closed" from "everything open" and
// from "everything closed".
const FILES = [
  file('server/src/app.ts'),
  file('scripts/seed.py'),
  file('README.md'),
]

function renderTree(activePath = '') {
  return render(
    <MemoryRouter>
      <RepositoryFileTree repositoryId="r1" files={FILES} activePath={activePath} />
    </MemoryRouter>,
  )
}

describe('RepositoryFileTree', () => {
  it('opens top-level folders and keeps deeper ones closed, with no file hidden forever', async () => {
    const { container } = renderTree()

    // Top level: both folders expanded, so their direct children show.
    expect(screen.getByRole('button', { name: 'server' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'scripts/seed.py' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'README.md' })).toBeInTheDocument()
    // One level down: `server/src` is closed, and the file inside it absent.
    expect(screen.getByRole('button', { name: 'server/src' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'server/src/app.ts' })).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('expands and collapses a folder on click', async () => {
    renderTree()

    await userEvent.click(screen.getByRole('button', { name: 'server/src' }))
    expect(screen.getByRole('link', { name: 'server/src/app.ts' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'server/src' }))
    expect(screen.queryByRole('link', { name: 'server/src/app.ts' })).toBeNull()

    // Collapsing a top-level folder hides its whole subtree.
    await userEvent.click(screen.getByRole('button', { name: 'server' }))
    expect(screen.queryByRole('button', { name: 'server/src' })).toBeNull()
  })

  it('expands with ArrowRight and collapses with ArrowLeft from the keyboard', async () => {
    renderTree()
    const src = screen.getByRole('button', { name: 'server/src' })

    src.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(src).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'server/src/app.ts' })).toBeInTheDocument()

    await userEvent.keyboard('{ArrowLeft}')
    expect(src).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'server/src/app.ts' })).toBeNull()
  })

  it('holds the open file’s ancestors open and marks its row as current', () => {
    renderTree('server/src/app.ts')

    const active = screen.getByRole('link', { name: 'server/src/app.ts' })
    expect(active).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'scripts/seed.py' })).not.toHaveAttribute('aria-current')
  })

  it('reveals a newly opened file inside a collapsed folder when the path changes', async () => {
    const { rerender } = renderTree()

    // The folder is closed and stays closed until navigation needs it.
    expect(screen.queryByRole('link', { name: 'server/src/app.ts' })).toBeNull()

    rerender(
      <MemoryRouter>
        <RepositoryFileTree repositoryId="r1" files={FILES} activePath="server/src/app.ts" />
      </MemoryRouter>,
    )

    const active = await screen.findByRole('link', { name: 'server/src/app.ts' })
    expect(active).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'server/src' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('links every file to its viewer route', () => {
    renderTree()
    expect(screen.getByRole('link', { name: 'scripts/seed.py' })).toHaveAttribute(
      'href',
      '/repos/r1/files/scripts/seed.py',
    )
  })
})
