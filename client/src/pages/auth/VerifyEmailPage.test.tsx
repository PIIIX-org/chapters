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
  return router
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

    // Copy changed with the step-3 rework: the screen now leads with the
    // confirmation and then says who has to act next.
    await waitFor(() => expect(screen.getByText('Email confirmed.')).toBeInTheDocument())
  })

  it('shows an error for an invalid code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(400, { error: 'invalid code' })))
    renderPage({ email: 'new@example.com' })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Verification code'), '000000')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => expect(screen.getByText('invalid code')).toBeInTheDocument())
  })
  it('names the approval wait, and warns that sign-in will look like a wrong password', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'verified' })))
    renderPage({ email: 'new@example.com' })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    // Without this line the person sees "invalid credentials" at login
    // indefinitely — correct, because the login screen must not confirm an
    // address exists, but meaningless unless it is explained here.
    expect(await screen.findByText(/has to approve your account/i)).toBeInTheDocument()
    expect(screen.getByText(/that is the approval waiting, not your password/i)).toBeInTheDocument()
  })
  it('shows where someone is in the whole route, from the first screen', async () => {
    renderPage({ email: 'new@example.com' })

    // Step 3 exists as a named part of the journey before anyone is stuck in
    // it — that is the entire reason the indicator is here.
    expect(screen.getByText('Admin approval')).toBeInTheDocument()
    expect(screen.getByText('Confirm your email')).toHaveAttribute('aria-current', 'step')
  })

  it('after verifying, says who has to act next and that we will tell them', async () => {
    // The one step the person cannot act on. It does end by itself: approving
    // calls notify(), which emails them — so this promise is one the server
    // actually keeps.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'verified' })))
    renderPage({ email: 'new@example.com' })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    expect(await screen.findByText(/administrator on this instance has to approve/i)).toBeInTheDocument()
    expect(screen.getByText(/we.ll email you the moment they do/i)).toBeInTheDocument()
    // And the marker has moved on: they are now waiting, not verifying.
    expect(screen.getByText('Admin approval')).toHaveAttribute('aria-current', 'step')
  })

  it('explains the wrong-password lie the login screen is about to tell them', async () => {
    // Login stays generic on purpose (account enumeration). Without this
    // sentence the person hits "your email or password is wrong" forever and
    // reasonably concludes their password is broken.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'verified' })))
    renderPage({ email: 'new@example.com' })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    expect(await screen.findByText(/that is the approval waiting, not your password/i)).toBeInTheDocument()
  })

  it('gives a way onward instead of ending in a dead end', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'verified' })))
    const router = renderPage({ email: 'new@example.com' })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    await user.click(await screen.findByRole('link', { name: /go to sign in/i }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
  })
})
