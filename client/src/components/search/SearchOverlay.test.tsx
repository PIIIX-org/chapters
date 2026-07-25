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
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, [
        { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'people/jane', snippet: 'about jane', score: 1 },
        { resourceType: 'code', id: 'c1', containerId: 'r1', path: 'src/x.ts', snippet: 'code', score: 0.5 },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { onClose, router } = renderOverlay(true)

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'jane' } })

    // Inside the ~250ms debounce window → no request yet. (This fails if the
    // debounce is removed and the query fires synchronously.)
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).not.toHaveBeenCalled()

    // Past the window → request fires.
    await vi.advanceTimersByTimeAsync(200)

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

  it('closes on a backdrop click but not on a click inside the panel', () => {
    const { onClose } = renderOverlay(true)
    const input = screen.getByPlaceholderText(/search/i)
    const panel = input.parentElement as HTMLElement
    const backdrop = panel.parentElement as HTMLElement

    // A mousedown inside the panel must NOT close.
    fireEvent.mouseDown(panel)
    expect(onClose).not.toHaveBeenCalled()

    // A mousedown on the backdrop itself closes.
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
