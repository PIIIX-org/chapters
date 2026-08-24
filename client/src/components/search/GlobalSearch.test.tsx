import { describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  it('opens the overlay on Cmd/Ctrl+K and closes on Escape', async () => {
    renderGlobal()
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()

    // Opening has no element to touch yet — the overlay doesn't exist until
    // this fires — so this one stays a direct keydown on window, matching
    // the real listener's target.
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true })
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()

    // Escape, by contrast, has a real target once the overlay is open: the
    // autofocused input. No explicit target here proves the handler lives
    // where a user's keystroke actually lands.
    const user = userEvent.setup()
    await user.keyboard('{Escape}')
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })

  it('does NOT open on Shift+Mod+K (that is the editor delete-line shortcut)', () => {
    renderGlobal()
    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true, shiftKey: true })
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })
})
