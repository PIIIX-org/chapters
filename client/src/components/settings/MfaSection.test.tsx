import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { SessionUser } from '../../api/auth.js'
import { MfaSection } from './MfaSection.js'

const BASE: SessionUser = {
  id: 'u1',
  email: 'reader@example.com',
  status: 'active',
  role: 'member',
  createdAt: '2026-08-01T10:00:00.000Z',
  mfaEnabledAt: null,
  mfaRequired: false,
}

// The three states, kept distinct on BOTH fields. A fixture that varied only
// mfaRequired could not tell state C from a component that hides Disable
// whenever it feels like it.
const NOT_ENROLLED: SessionUser = BASE
const ENROLLED: SessionUser = { ...BASE, mfaEnabledAt: '2026-08-14T09:30:00.000Z' }
const ENROLLED_MANDATED: SessionUser = { ...ENROLLED, mfaRequired: true }
const NOT_ENROLLED_MANDATED: SessionUser = { ...BASE, mfaRequired: true }

const SETUP = { secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/Chapters:reader@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Chapters' }
const BACKUP_CODES = ['aaaa-1111', 'bbbb-2222', 'cccc-3333']

type Route = (init?: RequestInit) => Response

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

/** Routes keyed `METHOD /api/path`; an unstubbed call is a test bug, not a 404. */
function stubFetch(routes: Record<string, Route>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const route = routes[key]
    if (!route) throw new Error(`unstubbed request: ${key}`)
    return Promise.resolve(route(init))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const session = (user: SessionUser): Route => () => mockJsonResponse(200, user)

const DISABLE_BUTTON = { name: 'Disable two-factor authentication' }
const SETUP_BUTTON = { name: 'Set up two-factor authentication' }

describe('MfaSection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers enrolment when MFA is off, and shows the key and URI only after starting', async () => {
    stubFetch({
      'GET /api/me': session(NOT_ENROLLED),
      'POST /api/mfa/setup': () => mockJsonResponse(200, SETUP),
    })
    const { container } = renderWithClient(<MfaSection />)

    const setup = await screen.findByRole('button', SETUP_BUTTON)
    // Nothing secret before it is asked for, and nothing to disable.
    expect(screen.queryByText(SETUP.secret)).toBeNull()
    expect(screen.queryByRole('button', DISABLE_BUTTON)).toBeNull()

    await userEvent.click(setup)

    expect(await screen.findByText(SETUP.secret)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: SETUP.uri })).toHaveAttribute('href', SETUP.uri)
    expect(screen.getByLabelText('6-digit code from your authenticator app')).toBeInTheDocument()

    await expectNoA11yViolations(container)
  })

  it('shows the backup codes exactly once after enabling, one per line, and drops them on dismiss', async () => {
    let enrolled = false
    stubFetch({
      'GET /api/me': () => mockJsonResponse(200, enrolled ? ENROLLED : NOT_ENROLLED),
      'POST /api/mfa/setup': () => mockJsonResponse(200, SETUP),
      'POST /api/mfa/enable': () => {
        enrolled = true
        return mockJsonResponse(200, { status: 'enabled', backupCodes: BACKUP_CODES })
      },
    })
    renderWithClient(<MfaSection />)

    await userEvent.click(await screen.findByRole('button', SETUP_BUTTON))
    await userEvent.type(await screen.findByLabelText('6-digit code from your authenticator app'), '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Turn on two-factor authentication' }))

    const reveal = await screen.findByText(/aaaa-1111/, { selector: 'code' })
    // Every code, one per line, and no leftovers from a previous reveal.
    expect(reveal.textContent).toBe(BACKUP_CODES.join('\n'))
    expect(screen.queryAllByText(/aaaa-1111/, { selector: 'code' })).toHaveLength(1)
    // The enrolled state arrived underneath them.
    await screen.findByRole('button', DISABLE_BUTTON)
    // …and the setup key is gone with the panel that showed it.
    expect(screen.queryByText(SETUP.secret)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.queryByText(/aaaa-1111/)).toBeNull()
    expect(screen.queryByText(/bbbb-2222/)).toBeNull()
  })

  it('surfaces a rejected code inline instead of pretending it enrolled', async () => {
    stubFetch({
      'GET /api/me': session(NOT_ENROLLED),
      'POST /api/mfa/setup': () => mockJsonResponse(200, SETUP),
      'POST /api/mfa/enable': () => mockJsonResponse(400, { error: 'that code is not valid' }),
    })
    renderWithClient(<MfaSection />)

    await userEvent.click(await screen.findByRole('button', SETUP_BUTTON))
    await userEvent.type(await screen.findByLabelText('6-digit code from your authenticator app'), '000000')
    await userEvent.click(screen.getByRole('button', { name: 'Turn on two-factor authentication' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('that code is not valid')
    expect(screen.queryByText(/backup codes/i)).toBeNull()
    expect(screen.getByLabelText('6-digit code from your authenticator app')).toBeInTheDocument()
  })

  it('offers Disable when the instance does not mandate MFA, and sends the code with it', async () => {
    const fetchMock = stubFetch({
      'GET /api/me': session(ENROLLED),
      'POST /api/mfa/disable': () => mockJsonResponse(200, { status: 'disabled' }),
    })
    const { container } = renderWithClient(<MfaSection />)

    await userEvent.click(await screen.findByRole('button', DISABLE_BUTTON))

    // Inline consequence, in plain language, before anything happens.
    const consequence = screen.getByText(/stops asking for a second factor/i)
    expect(consequence).toHaveTextContent(/existing backup codes stop working/i)

    await userEvent.type(
      screen.getByLabelText('Code from your authenticator app, or one of your backup codes'),
      'zzzz-9999',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Turn off two-factor authentication' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/mfa/disable',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: 'zzzz-9999' }) }),
      )
    })

    await expectNoA11yViolations(container)
  })

  it('offers no Disable control at all when the instance mandates MFA', async () => {
    stubFetch({ 'GET /api/me': session(ENROLLED_MANDATED) })
    const { container } = renderWithClient(<MfaSection />)

    expect(await screen.findByText(/An admin requires two-factor authentication/i)).toBeInTheDocument()
    // The server 403s it: no button, and no code field to type into either.
    expect(screen.queryByRole('button', DISABLE_BUTTON)).toBeNull()
    expect(screen.queryByRole('button', { name: /disable/i })).toBeNull()
    expect(
      screen.queryByLabelText('Code from your authenticator app, or one of your backup codes'),
    ).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('still offers enrolment to someone the mandate applies to but who has none', async () => {
    stubFetch({ 'GET /api/me': session(NOT_ENROLLED_MANDATED) })
    renderWithClient(<MfaSection />)

    expect(await screen.findByRole('button', SETUP_BUTTON)).toBeInTheDocument()
    expect(screen.queryByRole('button', DISABLE_BUTTON)).toBeNull()
  })

  it('surfaces a failed session read rather than rendering as "two-factor is off"', async () => {
    stubFetch({ 'GET /api/me': () => mockJsonResponse(401, { error: 'not signed in' }) })
    renderWithClient(<MfaSection />)

    expect(await screen.findByRole('alert')).toHaveTextContent('not signed in')
    expect(screen.queryByRole('button', SETUP_BUTTON)).toBeNull()
  })
  it('never shows the un-enrol button while the session is still catching up', async () => {
    // The window this closes: enable succeeds, backup codes appear, but the
    // session refetch has not landed, so a branch gated on mfaEnabledAt alone
    // renders the not-enrolled panel under the codes — with a live Set-up
    // button that POSTs /mfa/setup and silently un-enrols the user. The
    // default stub hides it by resolving in the same microtask, so this one
    // delays the post-enable /api/me deliberately.
    let enabled = false
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url}`
      if (key === 'GET /api/me') {
        const body = enabled ? ENROLLED : NOT_ENROLLED
        // Only the refetch is slow; the first read resolves immediately.
        if (!enabled) return Promise.resolve(mockJsonResponse(200, body))
        return new Promise<Response>((resolve) =>
          setTimeout(() => resolve(mockJsonResponse(200, body)), 150),
        )
      }
      if (key === 'POST /api/mfa/setup') return Promise.resolve(mockJsonResponse(200, SETUP))
      if (key === 'POST /api/mfa/enable') {
        enabled = true
        return Promise.resolve(mockJsonResponse(200, { status: 'enabled', backupCodes: BACKUP_CODES }))
      }
      throw new Error(`unstubbed request: ${key}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<MfaSection />)
    await userEvent.click(await screen.findByRole('button', SETUP_BUTTON))
    await userEvent.type(await screen.findByLabelText(/6-digit code/i), '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Turn on two-factor authentication' }))

    // The codes are on screen, so enrolment has definitely happened.
    expect(await screen.findByText('aaaa-1111', { exact: false })).toBeInTheDocument()
    // …and in that same moment the panel must already read as enrolled.
    expect(screen.queryByRole('button', SETUP_BUTTON)).toBeNull()
    expect(screen.queryByText(/Off\. Signing in asks for your password/i)).toBeNull()
  })

  it('tells someone under a mandate why they are being asked, not just that they can enrol', async () => {
    // Without this the whole `mfaRequired` read in the not-enrolled branch can
    // be deleted and every other test stays green: they only assert Set-up is
    // present and Disable absent, which is equally true unmandated.
    stubFetch({ 'GET /api/me': session(NOT_ENROLLED_MANDATED) })
    renderWithClient(<MfaSection />)

    expect(await screen.findByText(/An admin requires two-factor authentication/i)).toBeInTheDocument()
  })

  it('does not say that to someone the mandate does not apply to', async () => {
    // The other half: without it the assertion above passes against hardcoded
    // copy that ignores mfaRequired entirely. Separate test rather than a
    // second render, because cleanup only runs between tests.
    stubFetch({ 'GET /api/me': session(NOT_ENROLLED) })
    renderWithClient(<MfaSection />)

    await screen.findByRole('button', SETUP_BUTTON)
    expect(screen.queryByText(/An admin requires two-factor authentication/i)).toBeNull()
  })
})
