import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { ResetPasswordPage } from './ResetPasswordPage'

function renderPage(initialPath: string) {
  const router = createMemoryRouter(
    [
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: [initialPath] },
  )
  render(<RouterProvider router={router} />)
}

describe('ResetPasswordPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the token from the query string and submits a new password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'password_updated' }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage('/reset-password?token=abc123')
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('New password'), 'a-new-strong-password')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reset-password',
      expect.objectContaining({
        body: JSON.stringify({ token: 'abc123', password: 'a-new-strong-password' }),
      }),
    )
  })

  it('shows an error for an invalid or expired token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(400, { error: 'invalid or expired token' })))
    renderPage('/reset-password?token=expired')
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('New password'), 'a-new-strong-password')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    await waitFor(() => expect(screen.getByText('invalid or expired token')).toBeInTheDocument())
  })
})
