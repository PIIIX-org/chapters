import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { SearchOverlay } from './SearchOverlay'

function renderOverlay(open = true) {
  const onClose = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/', element: <SearchOverlay open={open} onClose={onClose} /> }],
    { initialEntries: ['/'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { onClose, router }
}

describe('SearchOverlay', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders nothing when closed', () => {
    renderOverlay(false)
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })

  it('debounce-searches and shows note results; clicking one navigates + closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, [
          { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'people/jane', snippet: 'about jane', score: 1 },
          { resourceType: 'code', id: 'c1', containerId: 'r1', path: 'src/x.ts', snippet: 'code', score: 0.5 },
        ]),
      ),
    )
    const { onClose, router } = renderOverlay(true)

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'jane' } })
    await vi.advanceTimersByTimeAsync(300)

    // note result shown, code result filtered out
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())
    expect(screen.queryByText('src/x.ts')).toBeNull()

    fireEvent.click(screen.getByText('people/jane'))
    expect(router.state.location.pathname).toBe('/vaults/v1/notes/people/jane')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const { onClose } = renderOverlay(true)
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
