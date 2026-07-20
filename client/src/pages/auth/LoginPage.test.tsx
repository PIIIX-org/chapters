import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { LoginPage } from './LoginPage'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage /> },
      { path: '/', element: <div>Home</div> },
    ],
    { initialEntries: ['/login'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('LoginPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('logs in and navigates home on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'u1', email: 'a@b.com', role: 'member' })),
    )
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument())
  })

  it('shows an error for invalid credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'invalid credentials' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    await waitFor(() => expect(screen.getByText('invalid credentials')).toBeInTheDocument())
  })

  it('shows an inline TOTP field when MFA is required, then completes login', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJsonResponse(401, { error: 'totp code required', mfaRequired: true }))
      .mockResolvedValueOnce(mockJsonResponse(200, { id: 'u1', email: 'a@b.com', role: 'member' }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    const totpField = await screen.findByLabelText('Authentication code')
    await user.type(totpField, '123456')
    await user.click(screen.getByRole('button', { name: 'Verify code' }))

    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/login',
      expect.objectContaining({
        body: JSON.stringify({ email: 'a@b.com', password: 'password123', totp: '123456' }),
      }),
    )
  })
})
