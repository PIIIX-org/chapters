import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { RequestPasswordResetPage } from './RequestPasswordResetPage'

function renderPage() {
  const router = createMemoryRouter([{ path: '/forgot-password', element: <RequestPasswordResetPage /> }], {
    initialEntries: ['/forgot-password'],
  })
  render(<RouterProvider router={router} />)
}

describe('RequestPasswordResetPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('always shows the same confirmation message (anti-enumeration)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'ok' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    await waitFor(() =>
      expect(screen.getByText(/if an account exists for that email/i)).toBeInTheDocument(),
    )
  })

  it('shows the same confirmation message when the API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(500, { error: 'server error' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    await waitFor(() =>
      expect(screen.getByText(/if an account exists for that email/i)).toBeInTheDocument(),
    )
  })
})
