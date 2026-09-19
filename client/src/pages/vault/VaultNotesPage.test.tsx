import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { mockJsonResponse } from '../../lib/api.js'
import { VaultNotesPage } from './VaultNotesPage.js'

const VAULTS = [
  { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
]

const TREE = {
  meetings: [
    {
      id: 'n1',
      path: 'meetings/sprint-planning.md',
      type: 'meetings',
      name: 'Sprint Planning',
      frontmatter: {},
      updatedAt: '2026-09-18T10:00:00Z',
    },
  ],
  architecture: [
    {
      id: 'n2',
      path: 'architecture/db-schema.md',
      type: 'architecture',
      name: 'DB Schema',
      frontmatter: {},
      updatedAt: '2026-09-17T10:00:00Z',
    },
  ],
}

function stubFetch(vaults: unknown = VAULTS, tree: unknown = TREE) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(200, vaults))
      if (url === '/api/vaults/v1/tree') return Promise.resolve(mockJsonResponse(200, tree))
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    }),
  )
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/vaults/v1']}>
        <Routes>
          <Route path="/vaults/:vaultId" element={<VaultNotesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('VaultNotesPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('renders notes as cards with links', async () => {
    stubFetch()
    renderPage()

    expect(await screen.findByRole('link', { name: 'Sprint Planning' })).toHaveAttribute(
      'href',
      '/vaults/v1/notes/meetings/sprint-planning.md',
    )
    expect(screen.getByRole('link', { name: 'DB Schema' })).toHaveAttribute(
      'href',
      '/vaults/v1/notes/architecture/db-schema.md',
    )
  })

  it('can toggle between card view and list view', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Sprint Planning' })
    expect(screen.queryByRole('table')).toBeNull()

    // Switch to list view
    fireEvent.click(screen.getByRole('button', { name: 'List view' }))
    expect(screen.getByRole('table')).toBeInTheDocument()

    // Switch back to card view
    fireEvent.click(screen.getByRole('button', { name: 'Card view' }))
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('filters notes by search term', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Sprint Planning' })
    expect(screen.getByRole('link', { name: 'DB Schema' })).toBeInTheDocument()

    const searchInput = screen.getByRole('textbox', { name: 'Search notes' })
    fireEvent.change(searchInput, { target: { value: 'Sprint' } })

    expect(screen.getByRole('link', { name: 'Sprint Planning' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'DB Schema' })).toBeNull()
  })

  it('allows organizing a note into a folder with custom color', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Sprint Planning' })
    const organizeBtn = screen.getByRole('button', {
      name: /folder: meetings for sprint planning/i,
    })
    expect(organizeBtn).toBeDefined()
    fireEvent.click(organizeBtn)

    expect(await screen.findByRole('heading', { name: 'Organize Note' })).toBeInTheDocument()

    const folderInput = await screen.findByLabelText(/folder name/i)
    fireEvent.change(folderInput, { target: { value: 'Projects' } })

    // Open custom in-app folder color picker
    const openFolderColorBtn = screen.getByRole('button', {
      name: 'Open custom folder color picker',
    })
    fireEvent.click(openFolderColorBtn)

    expect(await screen.findByRole('heading', { name: 'Folder Color' })).toBeInTheDocument()
    const hexInput = screen.getByLabelText(/hex code/i)
    fireEvent.change(hexInput, { target: { value: '#3b82f6' } })

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    // Save note folder dialog
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // Folder badge updated
    expect(
      await screen.findByRole('button', {
        name: /folder: projects for sprint planning/i,
      }),
    ).toBeInTheDocument()
  })

  it('allows pinning/favoriting a note to top', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Sprint Planning' })
    const favBtn = screen.getByRole('button', { name: 'Favorite DB Schema' })
    fireEvent.click(favBtn)

    expect(screen.getByRole('button', { name: 'Unfavorite DB Schema' })).toBeInTheDocument()
  })

  it('allows grouping notes by folder', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Sprint Planning' })
    const groupBtn = screen.getByRole('button', { name: 'Group by folder' })
    fireEvent.click(groupBtn)

    // Check grouped view displays folder sections
    expect(screen.getAllByText('meetings').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('architecture').length).toBeGreaterThanOrEqual(1)
  })
})
