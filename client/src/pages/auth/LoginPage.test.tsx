import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { LoginPage } from './LoginPage'

/**
 * Route-aware fetch stub: the page now asks /api/auth-config on mount, and a
 * real Response body is single-read, so one shared mockResolvedValue would be
 * consumed by whichever call got there second. Auth-config is answered by
 * shape; everything else takes the next response factory in order.
 */
function stubFetch(
  authConfig: { oidc: boolean; oidcOnly: boolean },
  ...responses: Array<() => Response>
) {
  let i = 0
  const fetchMock = vi.fn().mockImplementation((url: unknown) => {
    if (String(url).includes('/auth-config')) {
      return Promise.resolve(mockJsonResponse(200, authConfig))
    }
    const make = responses[Math.min(i, responses.length - 1)]
    i += 1
    return Promise.resolve(make ? make() : mockJsonResponse(500, { error: 'unexpected call' }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const NO_SSO = { oidc: false, oidcOnly: false }

function renderPage(initialEntry = '/login') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage /> },
      { path: '/', element: <div>Home</div> },
      { path: '/signup', element: <div>Sign-up page</div> },
      { path: '/forgot-password', element: <div>Forgot password page</div> },
    ],
    { initialEntries: [initialEntry] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('LoginPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('logs in and navigates home on success', async () => {
    stubFetch(NO_SSO, () => mockJsonResponse(200, { id: 'u1', email: 'a@b.com', role: 'member' }))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument())
  })

  it('shows an error for invalid credentials', async () => {
    stubFetch(NO_SSO, () => mockJsonResponse(401, { error: 'invalid credentials' }))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    await waitFor(() => expect(screen.getByText('invalid credentials')).toBeInTheDocument())
  })

  it('shows an inline TOTP field when MFA is required, then completes login', async () => {
    const fetchMock = stubFetch(
      NO_SSO,
      () => mockJsonResponse(401, { error: 'totp code required', mfaRequired: true }),
      () => mockJsonResponse(200, { id: 'u1', email: 'a@b.com', role: 'member' }),
    )
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

  it('shows an error and stays on the TOTP field when the code is wrong', async () => {
    stubFetch(
      NO_SSO,
      () => mockJsonResponse(401, { error: 'totp code required', mfaRequired: true }),
      () => mockJsonResponse(401, { error: 'invalid totp code', mfaRequired: true }),
    )
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    const totpField = await screen.findByLabelText('Authentication code')
    await user.type(totpField, '000000')
    await user.click(screen.getByRole('button', { name: 'Verify code' }))

    await waitFor(() => expect(screen.getByText('invalid totp code')).toBeInTheDocument())
    expect(screen.getByLabelText('Authentication code')).toBeInTheDocument()
  })
  it('offers a route to sign-up, without which a new person cannot reach it at all', async () => {
    // There was no link to /signup anywhere in the app. The page existed and
    // worked; you could only get to it by typing the URL. Same cold-start trap
    // as vault creation (unit 1) and connecting a repository (unit 7).
    stubFetch(NO_SSO)
    const router = renderPage()

    await userEvent.click(screen.getByRole('link', { name: /create an account/i }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/signup'))
  })

  it('routes to forgot-password instead of reloading the whole app', async () => {
    // It was a raw <a href>, which throws away the SPA and reboots it.
    stubFetch(NO_SSO)
    const router = renderPage()

    await userEvent.click(screen.getByRole('link', { name: /forgot your password/i }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/forgot-password'))
  })

  it('offers single sign-on alongside the password form when OIDC is configured', async () => {
    stubFetch({ oidc: true, oidcOnly: false })
    renderPage()

    const sso = await screen.findByRole('link', { name: /single sign-on/i })
    expect(sso).toHaveAttribute('href', '/api/oidc/login')
    // Password login is still a door.
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
  })

  it('hides every password surface when the instance is OIDC-only', async () => {
    stubFetch({ oidc: true, oidcOnly: true })
    renderPage()

    await screen.findByRole('link', { name: /single sign-on/i })
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /create an account/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /forgot your password/i })).not.toBeInTheDocument()
  })

  it('surfaces a failed SSO round-trip', async () => {
    stubFetch({ oidc: true, oidcOnly: true })
    renderPage('/login?error=sso')

    await waitFor(() => expect(screen.getByText(/single sign-on failed/i)).toBeInTheDocument())
  })
})
