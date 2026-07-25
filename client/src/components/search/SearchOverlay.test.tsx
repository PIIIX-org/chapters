import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  beforeEach(() => {
    // jsdom does not implement scrollIntoView; the active-row auto-scroll calls it.
    Element.prototype.scrollIntoView = vi.fn()
  })

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

  it('ArrowDown/ArrowUp move the highlighted row and Enter opens it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, [
        { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'people/jane', snippet: 'a', score: 1 },
        { resourceType: 'note', id: 'n2', containerId: 'v2', path: 'people/john', snippet: 'b', score: 0.9 },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { onClose, router } = renderOverlay(true)

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'p' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => expect(screen.getByText('people/jane')).toBeInTheDocument())

    const input = screen.getByPlaceholderText(/search/i)
    const options = () => screen.getAllByRole('option')

    // First row selected by default.
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')

    // ArrowDown -> second row selected.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')
    expect(options()[0]).toHaveAttribute('aria-selected', 'false')

    // ArrowDown at the end clamps (stays on last).
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')

    // Enter opens the active (second) row and closes.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(router.state.location.pathname).toBe('/vaults/v2/notes/people/john')
    expect(onClose).toHaveBeenCalled()
  })

  it('ArrowUp clamps at the first row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockJsonResponse(200, [
        { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'a', snippet: 'x', score: 1 },
        { resourceType: 'note', id: 'n2', containerId: 'v2', path: 'b', snippet: 'y', score: 0.9 },
      ]),
    ))
    renderOverlay(true)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'p' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument())

    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.keyDown(input, { key: 'ArrowUp' }) // already at 0 -> stays
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('resets selection to the first row when the query changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockJsonResponse(200, [
        { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'a', snippet: 'x', score: 1 },
        { resourceType: 'note', id: 'n2', containerId: 'v2', path: 'b', snippet: 'y', score: 0.9 },
      ]),
    ))
    renderOverlay(true)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'p' } })
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => expect(screen.getByText('a')).toBeInTheDocument())

    fireEvent.keyDown(input, { key: 'ArrowDown' }) // select row 2
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')

    fireEvent.change(input, { target: { value: 'pq' } }) // new query
    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true'))
  })
})
