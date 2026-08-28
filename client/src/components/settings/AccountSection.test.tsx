import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { SessionUser } from '../../api/auth.js'
import { AccountSection } from './AccountSection.js'

// A distinctive address, so "you sign in as …" cannot pass by rendering
// something hardcoded.
const SESSION: SessionUser = {
  id: 'u1',
  email: 'sam.old@example.com',
  status: 'active',
  role: 'member',
  createdAt: '2026-08-01T00:00:00.000Z',
  mfaEnabledAt: null,
  mfaRequired: false,
}

// MemoryRouter: the success state links to /verify-email, and a bare <Link>
// throws outside a router.
function renderWithClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AccountSection />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** GET /me returns the session; every POST is answered by `post`. */
function stubFetch(post: (url: string) => Response = () => mockJsonResponse(200, {})) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) =>
    Promise.resolve(init?.method === 'POST' ? post(url) : mockJsonResponse(200, SESSION)),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function posted(fetchMock: ReturnType<typeof vi.fn>, path: string): boolean {
  return fetchMock.mock.calls.some(
    ([url, init]) => url === path && (init as RequestInit | undefined)?.method === 'POST',
  )
}

async function fillPasswordForm(values: { current: string; next: string; confirm: string }) {
  await userEvent.type(await screen.findByLabelText('Current password'), values.current)
  await userEvent.type(screen.getByLabelText('New password'), values.next)
  await userEvent.type(screen.getByLabelText('Confirm new password'), values.confirm)
}

async function fillEmailForm(email: string) {
  await userEvent.type(await screen.findByLabelText('New email address'), email)
  await userEvent.type(screen.getByLabelText('Your password'), 'hunter2')
}

describe('AccountSection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the address you actually sign in as', async () => {
    stubFetch()
    const { container } = renderWithClient()

    expect(await screen.findByText('sam.old@example.com')).toBeInTheDocument()

    await expectNoA11yViolations(container)
  })

  it('refuses a new password that does not match the confirmation, without asking the server', async () => {
    const fetchMock = stubFetch()
    renderWithClient()

    await fillPasswordForm({ current: 'old-pw', next: 'brand-new-pw', confirm: 'brand-new-pwx' })
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/not the same/)
    // The point of guarding client-side: a typo must not spend a
    // wrong-password attempt at the server.
    expect(posted(fetchMock, '/api/me/password')).toBe(false)
  })

  it('surfaces the wrong-current-password error from the server', async () => {
    const fetchMock = stubFetch(() =>
      // 400, which is what the server actually returns for a wrong current
      // password (account-routes.ts). A 403 fixture asserted a contract the
      // server does not honour.
      mockJsonResponse(400, { error: 'current password is incorrect' }),
    )
    renderWithClient()

    await fillPasswordForm({ current: 'wrong-pw', next: 'brand-new-pw', confirm: 'brand-new-pw' })
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('current password is incorrect')
    // Matching passwords do reach the network — otherwise the test above
    // would pass for the wrong reason.
    expect(posted(fetchMock, '/api/me/password')).toBe(true)
    expect(screen.queryByText(/every other device signed in as you has been signed out/i)).toBeNull()
  })

  it('says every other device was signed out once the password changes', async () => {
    stubFetch(() => mockJsonResponse(200, { status: 'password_changed' }))
    renderWithClient()

    await fillPasswordForm({ current: 'old-pw', next: 'brand-new-pw', confirm: 'brand-new-pw' })
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(
      await screen.findByText(/every other device signed in as you has been signed out/i),
    ).toBeInTheDocument()
  })

  it('puts the lockout consequence on screen before it sends anything, and sends only on confirm', async () => {
    const fetchMock = stubFetch(() => mockJsonResponse(200, { status: 'verification_sent' }))
    renderWithClient()

    await fillEmailForm('sam.new@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Change email address' }))

    // Named consequences, not "Are you sure?": locked out, and a login screen
    // that lies about why.
    const consequence = await screen.findByText(/stops you being able to sign in/i)
    expect(consequence).toHaveTextContent(/sam\.new@example\.com/)
    expect(consequence).toHaveTextContent(/email or password is wrong/i)
    expect(posted(fetchMock, '/api/me/email')).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/me/email',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'sam.new@example.com', password: 'hunter2' }),
        }),
      )
    })
  })

  it('says the address is taken when the server answers 409', async () => {
    stubFetch(() => mockJsonResponse(409, {}))
    renderWithClient()

    await fillEmailForm('taken@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Change email address' }))
    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/already belongs to another account/i)
    // The 409 body carries no message, so anything status-blind renders
    // "Request failed (409)" here.
    expect(alert).not.toHaveTextContent(/Request failed/)
  })
  it('names the password length rule itself instead of relaying "Bad Request"', async () => {
    // The server's schema rejection puts the literal string "Bad Request" in
    // the `error` field, which is exactly what ApiError surfaces — so without
    // a local check the person is told "Bad Request" and never learns the rule.
    const fetchMock = stubFetch()
    renderWithClient()

    await userEvent.type(await screen.findByLabelText('Current password'), 'old-password')
    await userEvent.type(screen.getByLabelText('New password'), 'secret')
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'secret')
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(screen.getByRole('alert')).toHaveTextContent('at least 8 characters')
    expect(fetchMock).not.toHaveBeenCalledWith('/api/me/password', expect.anything())
  })

  it('rejects a malformed address before the lockout confirm, not after it', async () => {
    // The server enforces `format: email` and its rejection also arrives as
    // "Bad Request" — after the person has already read and accepted the
    // lockout consequence. type="email" cannot help: ConfirmAction's button is
    // type="button", so no native form validation ever fires.
    const fetchMock = stubFetch()
    renderWithClient()

    await userEvent.type(await screen.findByLabelText('New email address'), 'sam')
    await userEvent.type(screen.getByLabelText('Your password'), 'old-password')
    await userEvent.click(screen.getByRole('button', { name: 'Change email address' }))
    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))

    expect(screen.getByRole('alert')).toHaveTextContent('does not look like an email address')
    expect(fetchMock).not.toHaveBeenCalledWith('/api/me/email', expect.anything())
  })

  it('offers a way to the screen that accepts the code it just told you about', async () => {
    stubFetch(() => mockJsonResponse(200, { status: 'verification_sent' }))
    renderWithClient()

    await userEvent.type(await screen.findByLabelText('New email address'), 'new@example.com')
    await userEvent.type(screen.getByLabelText('Your password'), 'old-password')
    await userEvent.click(screen.getByRole('button', { name: 'Change email address' }))
    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))

    const link = await screen.findByRole('link', { name: /enter the code/i })
    expect(link).toHaveAttribute('href', '/verify-email')
  })
})
