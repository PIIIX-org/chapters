import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { GlobalSearch } from './GlobalSearch'

function renderGlobal(extra?: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <>
            {extra}
            <GlobalSearch />
          </>
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
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

  it('opens the overlay on a bare `/`', () => {
    renderGlobal()
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()

    fireEvent.keyDown(window, { key: '/' })
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()
  })

  it('leaves `/` alone while something editable has focus — the slash belongs to the text', () => {
    renderGlobal(<input aria-label="Note title" />)
    const field = screen.getByRole('textbox', { name: 'Note title' })
    field.focus()

    fireEvent.keyDown(field, { key: '/' })
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })

  it('ignores `/` with a modifier held (Ctrl+/ and friends are other tools’ shortcuts)', () => {
    renderGlobal()
    fireEvent.keyDown(window, { key: '/', ctrlKey: true })
    fireEvent.keyDown(window, { key: '/', altKey: true })
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })

  it('typing `/` into the open palette does not re-trigger or close anything', async () => {
    renderGlobal()
    fireEvent.keyDown(window, { key: '/' })
    const input = screen.getByPlaceholderText(/search/i)

    const user = userEvent.setup()
    await user.type(input, 'people/jane')

    expect(input).toHaveValue('people/jane')
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()
  })
})
