import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { SetupPage } from './SetupPage'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/setup', element: <SetupPage /> },
      { path: '/', element: <div>Home</div> },
    ],
    { initialEntries: ['/setup'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('SetupPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('submits the setup token/email/password and navigates home on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'admin-1' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Setup token'), 'the-setup-token')
    await user.type(screen.getByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'a-strong-password')
    await user.click(screen.getByRole('button', { name: 'Create admin account' }))

    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument())
  })

  it('shows an error when the token is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(403, { error: 'invalid setup token' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Setup token'), 'wrong-token')
    await user.type(screen.getByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'a-strong-password')
    await user.click(screen.getByRole('button', { name: 'Create admin account' }))

    await waitFor(() => expect(screen.getByText('invalid setup token')).toBeInTheDocument())
  })

  it('shows a specific message when setup is already complete', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(404, { error: 'setup is not available' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Setup token'), 'tok')
    await user.type(screen.getByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'a-strong-password')
    await user.click(screen.getByRole('button', { name: 'Create admin account' }))

    await waitFor(() => expect(screen.getByText(/this instance is already set up/i)).toBeInTheDocument())
  })
})
