import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { UniversalNewButton } from './UniversalNewButton.js'
import { mockJsonResponse } from '../../lib/api.js'

function renderComponent(initialRoute = '/', initialVaults?: any[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (initialVaults) {
    queryClient.setQueryData(['vaults'], initialVaults)
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <UniversalNewButton />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('UniversalNewButton', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the Universal New trigger button', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, [])))
    renderComponent()

    expect(screen.getByRole('button', { name: /universal new item/i })).toBeInTheDocument()
    expect(screen.getByText('New')).toBeInTheDocument()
  })

  it('opens dropdown menu with options when clicked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, [])))
    renderComponent()

    fireEvent.click(screen.getByRole('button', { name: /universal new item/i }))

    await waitFor(() => {
      expect(screen.getByText('New note')).toBeInTheDocument()
      expect(screen.getByText('New vault')).toBeInTheDocument()
      expect(screen.getByText('Connect repo')).toBeInTheDocument()
    })
  })

  it('opens New Vault modal when selecting New vault', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, [])))
    renderComponent()

    fireEvent.click(screen.getByRole('button', { name: /universal new item/i }))
    await waitFor(() => expect(screen.getByText('New vault')).toBeInTheDocument())

    fireEvent.click(screen.getByText('New vault'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'New vault' })).toBeInTheDocument()
      expect(screen.getByLabelText(/vault name/i)).toBeInTheDocument()
    })
  })

  it('opens Connect Repository modal when selecting Connect repo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, [])))
    renderComponent()

    fireEvent.click(screen.getByRole('button', { name: /universal new item/i }))
    await waitFor(() => expect(screen.getByText('Connect repo')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Connect repo'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /connect a repository/i })).toBeInTheDocument()
    })
  })

  it('opens New Note modal with vault picker when selecting New note outside a vault', async () => {
    const vaults = [
      { id: 'v1', name: 'Engineering', access: 'owner', mergeable: false },
      { id: 'v2', name: 'Design', access: 'owner', mergeable: false },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, vaults)))
    renderComponent('/', vaults)

    fireEvent.click(screen.getByRole('button', { name: /universal new item/i }))
    await waitFor(() => expect(screen.getByText('New note')).toBeInTheDocument())

    fireEvent.click(screen.getByText('New note'))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'New note' })).toBeInTheDocument()
      expect(screen.getByLabelText(/type/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
    })
  })
})
