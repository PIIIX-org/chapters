import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { MfaRequirementToggle } from './MfaRequirementToggle.js'

function session(mfaRequired: boolean) {
  return {
    id: 'me',
    email: 'admin@example.com',
    status: 'active',
    role: 'admin',
    createdAt: '2026-08-01T00:00:00.000Z',
    mfaEnabledAt: null,
    mfaRequired,
  }
}

function stubFetch(mfaRequired: boolean) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/admin/mfa-requirement' && init?.method === 'PUT') {
      return Promise.resolve(mockJsonResponse(200, { required: !mfaRequired }))
    }
    if (url === '/api/me') return Promise.resolve(mockJsonResponse(200, session(mfaRequired)))
    return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderToggle() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MfaRequirementToggle />
    </QueryClientProvider>,
  )
}

describe('MfaRequirementToggle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('flipping the switch on asks for confirmation first, and only the confirm PUTs', async () => {
    const fetch = stubFetch(false)
    const { container } = renderToggle()

    const toggle = await screen.findByRole('switch', {
      name: 'Require two-factor authentication',
    })
    expect(toggle).not.toBeChecked()

    await userEvent.click(toggle)
    // The consequence in plain language, before anything is sent — and the
    // switch itself stays put: it reflects the server, which has not changed.
    expect(
      screen.getByText(/Everyone without an authenticator app is sent to enrol/),
    ).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/mfa-requirement', expect.anything())
    expect(toggle).not.toBeChecked()

    await expectNoA11yViolations(container)

    await userEvent.click(screen.getByRole('button', { name: 'Require it' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/mfa-requirement',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ required: true }) }),
      ),
    )
  })

  it('cancel leaves the mandate alone', async () => {
    const fetch = stubFetch(false)
    renderToggle()

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Require two-factor authentication' }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText(/sent to enrol/)).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/mfa-requirement', expect.anything())
  })

  it('turning it off is the destructive direction, with its own consequence', async () => {
    const fetch = stubFetch(true)
    renderToggle()

    const toggle = await screen.findByRole('switch', {
      name: 'Stop requiring two-factor authentication',
    })
    expect(toggle).toBeChecked()

    await userEvent.click(toggle)
    expect(screen.getByText(/can turn its own second factor off again/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Stop requiring it' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/admin/mfa-requirement',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ required: false }) }),
      ),
    )
  })
})
