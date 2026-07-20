import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { VerifyEmailPage } from './VerifyEmailPage'

function renderPage(state?: { email: string }) {
  const router = createMemoryRouter(
    [
      { path: '/verify-email', element: <VerifyEmailPage /> },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: [{ pathname: '/verify-email', state }] },
  )
  render(<RouterProvider router={router} />)
}

describe('VerifyEmailPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pre-fills the email from router state and submits the code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'verified' })))
    renderPage({ email: 'new@example.com' })
    const user = userEvent.setup()

    expect(screen.getByLabelText('Email')).toHaveValue('new@example.com')
    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => expect(screen.getByText(/verified/i)).toBeInTheDocument())
  })

  it('shows an error for an invalid code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(400, { error: 'invalid code' })))
    renderPage({ email: 'new@example.com' })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Verification code'), '000000')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => expect(screen.getByText('invalid code')).toBeInTheDocument())
  })
})
