import { describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { GlobalSearch } from './GlobalSearch'

function renderGlobal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/', element: <GlobalSearch /> }], { initialEntries: ['/'] })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('GlobalSearch', () => {
  it('opens the overlay on Cmd/Ctrl+K and closes on Escape', () => {
    renderGlobal()
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()

    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: 'Escape' })
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })
})
