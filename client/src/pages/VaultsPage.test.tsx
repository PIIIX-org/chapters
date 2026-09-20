import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { mockJsonResponse } from '../lib/api'
import { expectNoA11yViolations } from '../test/axe'
import { VaultsPage } from './VaultsPage'

const VAULTS = [
  { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
  { id: 'v2', name: 'Recipes', ownerId: 'u2', mergeable: false, access: 'read' },
]

function stubFetch(vaults: unknown = VAULTS, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/vaults') return Promise.resolve(mockJsonResponse(status, vaults))
      if (url === '/api/vaults/trash') return Promise.resolve(mockJsonResponse(200, []))
      if (url === '/api/me/vault-preferences') {
        return Promise.resolve(
          mockJsonResponse(200, {
            storageMode: 'online',
            folders: {},
            folderColors: {},
            vaultColors: {},
            favorites: {},
          }),
        )
      }
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    }),
  )
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/vaults']}>
        <VaultsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('VaultsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists every reachable vault as a link, with owner actions only where owned', async () => {
    stubFetch()
    renderPage()

    expect(await screen.findByRole('link', { name: 'Engineering' })).toHaveAttribute('href', '/vaults/v1')
    expect(screen.getByRole('link', { name: 'Recipes' })).toHaveAttribute('href', '/vaults/v2')
    expect(screen.getByText('Owner')).toBeInTheDocument()
    expect(screen.getByText('Read only')).toBeInTheDocument()
    // Rename/delete exist for the owned vault and for nothing else.
    expect(screen.getByRole('button', { name: 'Rename Engineering' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rename Recipes' })).toBeNull()
  })

  it('shows the empty state, and an error state with retry, before ever reading data', async () => {
    stubFetch([])
    const { unmount } = renderPage()
    expect(await screen.findByText('No vaults yet')).toBeInTheDocument()
    unmount()

    stubFetch({ error: 'boom' }, 500)
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t load your vaults.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    stubFetch()
    const { container } = renderPage()
    await screen.findByRole('link', { name: 'Engineering' })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/vaults/trash', expect.anything()))
    await expectNoA11yViolations(container)
  })

  it('can toggle between card view and list view', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Engineering' })
    // In card view (default), cards are rendered
    expect(screen.queryByRole('table')).toBeNull()

    // Switch to list view
    fireEvent.click(screen.getByRole('button', { name: 'List view' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Folder' })).toBeInTheDocument()

    // Switch back to card view
    fireEvent.click(screen.getByRole('button', { name: 'Card view' }))
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('filters vaults by search term', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Engineering' })
    expect(screen.getByRole('link', { name: 'Recipes' })).toBeInTheDocument()

    // Search for "Eng"
    const searchInput = screen.getByRole('textbox', { name: 'Search vaults' })
    fireEvent.change(searchInput, { target: { value: 'Eng' } })

    expect(screen.getByRole('link', { name: 'Engineering' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Recipes' })).toBeNull()

    // Clear search
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByRole('link', { name: 'Recipes' })).toBeInTheDocument()
  })

  it('allows organizing a vault into a folder and filtering by folder', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Engineering' })

    // Open folder dialog for Engineering (button says "Add folder" initially)
    const addFolderBtn = screen.getAllByRole('button', { name: 'Add folder' })[0]
    expect(addFolderBtn).toBeDefined()
    fireEvent.click(addFolderBtn!)

    // Modal opens
    expect(await screen.findByRole('heading', { name: 'Organize Vault' })).toBeInTheDocument()

    // Type folder name
    const folderInput = await screen.findByLabelText(/folder name/i)
    fireEvent.change(folderInput, { target: { value: 'Work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // Now Engineering should show "Work" folder badge
    expect(await screen.findByRole('button', { name: 'Work' })).toBeInTheDocument()

    // Folder filter chip "Work" should appear in toolbar
    const workFilterChip = screen.getByRole('button', { name: /Work\s*\(1\)/ })
    expect(workFilterChip).toBeInTheDocument()

    // Click filter chip to filter by "Work"
    fireEvent.click(workFilterChip)
    expect(screen.getByRole('link', { name: 'Engineering' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Recipes' })).toBeNull()
  })

  it('allows starring a vault to pin it to the top', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Engineering' })
    const starRecipesBtn = screen.getByRole('button', { name: 'Favorite Recipes' })
    expect(starRecipesBtn).toBeInTheDocument()

    // Favorite "Recipes"
    fireEvent.click(starRecipesBtn)

    // Now it shows "Unfavorite Recipes"
    expect(screen.getByRole('button', { name: 'Unfavorite Recipes' })).toBeInTheDocument()
  })

  it('allows toggling group by folder view', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Engineering' })

    // Click Group by folder
    const groupBtn = screen.getByRole('button', { name: 'Group by folder' })
    fireEvent.click(groupBtn)

    // Since vaults are uncategorized, "Uncategorized" folder section appears
    expect(screen.getAllByText('Uncategorized').length).toBeGreaterThanOrEqual(2)

    // Click again to ungroup
    fireEvent.click(groupBtn)
    expect(screen.getAllByText('Uncategorized').length).toBe(1)
  })

  it('allows picking a folder color and vault color in the folder dialog', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Engineering' })
    const addFolderBtn = screen.getAllByRole('button', { name: 'Add folder' })[0]
    expect(addFolderBtn).toBeDefined()
    fireEvent.click(addFolderBtn!)

    expect(await screen.findByRole('heading', { name: 'Organize Vault' })).toBeInTheDocument()

    // Select Blue for vault accent
    const blueBtn = screen.getAllByTitle('Blue')[0]
    expect(blueBtn).toBeDefined()
    fireEvent.click(blueBtn!)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })

  it('allows picking a custom color via in-app color picker dialog', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Engineering' })
    const addFolderBtn = screen.getAllByRole('button', { name: 'Add folder' })[0]
    expect(addFolderBtn).toBeDefined()
    fireEvent.click(addFolderBtn!)

    expect(await screen.findByRole('heading', { name: 'Organize Vault' })).toBeInTheDocument()

    // Type folder name to reveal folder color picker
    const folderInput = await screen.findByLabelText(/folder name/i)
    fireEvent.change(folderInput, { target: { value: 'Design' } })

    // Open custom in-app folder color picker dialog
    const openFolderColorBtn = screen.getByRole('button', { name: 'Open custom folder color picker' })
    expect(openFolderColorBtn).toBeInTheDocument()
    fireEvent.click(openFolderColorBtn)

    // In-app Color Picker Dialog is open
    expect(await screen.findByRole('heading', { name: 'Folder Color' })).toBeInTheDocument()
    const hexInput = screen.getByLabelText(/hex code/i)
    fireEvent.change(hexInput, { target: { value: '#e11d48' } })

    // Click "Save" to add to palette
    const saveToPaletteBtn = screen.getByRole('button', { name: 'Add to saved palette' })
    fireEvent.click(saveToPaletteBtn)

    // Click "Confirm" to close color picker dialog and apply
    const confirmBtn = screen.getByRole('button', { name: 'Confirm' })
    fireEvent.click(confirmBtn)

    // Save folder dialog
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // Now Engineering should show "Design" folder button
    const designBadge = await screen.findByRole('button', { name: 'Design' })
    expect(designBadge).toBeInTheDocument()
  })

  it('allows opening storage settings and toggling between Online and Local storage', async () => {
    stubFetch()
    renderPage()

    await screen.findByRole('link', { name: 'Engineering' })

    const storageBtn = screen.getByRole('button', { name: 'Vault folders storage settings' })
    expect(storageBtn).toBeInTheDocument()
    expect(storageBtn).toHaveTextContent(/cloud/i)

    // Open storage settings modal
    fireEvent.click(storageBtn)
    expect(await screen.findByText(/Vault Folders & Group Storage/i)).toBeInTheDocument()
    expect(screen.getByText(/Online \(Cloud Synced\)/i)).toBeInTheDocument()
    expect(screen.getByText(/Local \(This Browser Only\)/i)).toBeInTheDocument()

    // Select Local mode
    fireEvent.click(screen.getByText(/Local \(This Browser Only\)/i))

    // Click Done to close
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText(/Vault Folders & Group Storage/i)).toBeNull()

    // Button should now reflect Local
    expect(storageBtn).toHaveTextContent(/local/i)
  })
})


