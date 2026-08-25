import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import { NotificationPreferences } from './NotificationPreferences.js'

// FALSE on purpose. A `true` fixture cannot tell a checkbox bound to the
// fetched value from one hardcoded `checked`, which is exactly the kind of
// vacuous test this repo has shipped before.
const PREFS_OFF = { emailNotifications: false }

const CHECKBOX = { name: /Email me about notifications/ }

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

/** GET returns the fixture; PUT returns whatever `put` says. */
function stubFetch(put: () => Response, get: Response = mockJsonResponse(200, PREFS_OFF)) {
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve(init?.method === 'PUT' ? put() : get),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('NotificationPreferences', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the checkbox unchecked when email notifications are off', async () => {
    stubFetch(() => mockJsonResponse(200, PREFS_OFF))
    const { container } = renderWithClient(<NotificationPreferences />)

    const checkbox = await screen.findByRole('checkbox', CHECKBOX)
    expect(checkbox).not.toBeChecked()
    // The distinction the single switch exists to make.
    expect(checkbox).toHaveAccessibleName(/notification bell keeps recording/)

    await expectNoA11yViolations(container)
  })

  it('sends the flipped value, not the current one', async () => {
    const fetchMock = stubFetch(() => mockJsonResponse(200, { emailNotifications: true }))
    renderWithClient(<NotificationPreferences />)

    await userEvent.click(await screen.findByRole('checkbox', CHECKBOX))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/me/preferences',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ emailNotifications: true }),
        }),
      )
    })
    // …and the box follows the write through, rather than snapping back.
    await waitFor(() => expect(screen.getByRole('checkbox', CHECKBOX)).toBeChecked())
  })

  it('surfaces a failed write instead of silently leaving the box where it was', async () => {
    stubFetch(() => mockJsonResponse(500, { error: 'could not save preferences' }))
    renderWithClient(<NotificationPreferences />)

    await userEvent.click(await screen.findByRole('checkbox', CHECKBOX))

    expect(await screen.findByRole('alert')).toHaveTextContent('could not save preferences')
    expect(screen.getByRole('checkbox', CHECKBOX)).not.toBeChecked()
  })

  it('surfaces a failed read rather than rendering a switch that is off', async () => {
    stubFetch(
      () => mockJsonResponse(200, PREFS_OFF),
      mockJsonResponse(401, { error: 'not signed in' }),
    )
    renderWithClient(<NotificationPreferences />)

    expect(await screen.findByRole('alert')).toHaveTextContent('not signed in')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})
