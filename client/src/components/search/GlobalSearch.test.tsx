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

    // Set both modifiers so the platform-specific check (Cmd on macOS, Ctrl
    // elsewhere) opens regardless of the test host's platform.
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true })
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()

    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: 'Escape' })
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })

  it('does NOT open on Shift+Mod+K (that is the editor delete-line shortcut)', () => {
    renderGlobal()
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true, shiftKey: true })
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })
})
