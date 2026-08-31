import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { mockJsonResponse } from '../lib/api.js'
import { expectNoA11yViolations } from '../test/axe.js'
import type { SessionUser } from '../api/auth.js'
import { SettingsPage } from './SettingsPage.js'

const BASE: SessionUser = {
  id: 'u1',
  email: 'reader@example.com',
  status: 'active',
  role: 'member',
  createdAt: '2026-08-01T10:00:00.000Z',
  mfaEnabledAt: null,
  mfaRequired: false,
}

/**
 * Under a mandate the server 403s every /me route except /me itself, so this
 * stub answers the way the real one does — otherwise the test would render a
 * page the deployed app never shows.
 */
function stubFetch(user: SessionUser) {
  const mandated = user.mfaRequired && !user.mfaEnabledAt
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/me') return Promise.resolve(mockJsonResponse(200, user))
    if (mandated) {
      return Promise.resolve(mockJsonResponse(403, { error: 'MFA setup required' }))
    }
    if (url === '/api/me/preferences') {
      return Promise.resolve(mockJsonResponse(200, { emailNotifications: true }))
    }
    if (url === '/api/mcp-connections') return Promise.resolve(mockJsonResponse(200, []))
    return Promise.resolve(mockJsonResponse(200, {}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SettingsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists the sections and opens on Account, one section at a time', async () => {
    stubFetch(BASE)
    const { container } = renderPage()

    // Account renders (both its panels)…
    expect(await screen.findByRole('heading', { name: 'Password' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Email address' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Account' })).toHaveAttribute('aria-current', 'page')

    // …and only Account: the other sections wait until they are asked for.
    expect(screen.queryByRole('heading', { name: 'MCP connections' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Export your account' })).toBeNull()

    await expectNoA11yViolations(container)
  })

  it('switches sections from the context list', async () => {
    stubFetch(BASE)
    const { container } = renderPage()
    const user = userEvent.setup()

    await screen.findByRole('heading', { name: 'Password' })
    await user.click(screen.getByRole('button', { name: 'MCP' }))
    expect(await screen.findByRole('heading', { name: 'MCP connections' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Password' })).toBeNull()

    // Appearance holds the theme switch — the one section the default-view axe
    // run never sees, so it gets its own gate.
    await user.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(await screen.findByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeInTheDocument()
    await expectNoA11yViolations(container)

    // Data pairs the export with the import.
    await user.click(screen.getByRole('button', { name: 'Data' }))
    expect(await screen.findByRole('heading', { name: 'Export your account' })).toBeInTheDocument()
  })

  it('shows enrolment alone under a mandate, not panels reading "MFA setup required"', async () => {
    // Found in a real browser, not by a test: every other panel's fetch 403s
    // under the mandate, so the page filled with the raw server error string
    // and buried the one control that ends the state.
    const mandated: SessionUser = { ...BASE, mfaRequired: true }
    stubFetch(mandated)
    const { container } = renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(/hidden until two-factor authentication is on/i)
    expect(
      screen.getByRole('button', { name: 'Set up two-factor authentication' }),
    ).toBeInTheDocument()

    // No section list either: every other section is a dead door until MFA is on.
    expect(screen.queryByRole('button', { name: 'Account' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Password' })).toBeNull()
    expect(container.textContent).not.toContain('MFA setup required')
  })

  it('brings the rest back once the mandate is satisfied', async () => {
    // A fixture of only the unenrolled-mandated case could not tell this page
    // from one that hides those panels whenever mfaRequired is set.
    const enrolled: SessionUser = { ...BASE, mfaRequired: true, mfaEnabledAt: '2026-08-14T09:30:00.000Z' }
    stubFetch(enrolled)
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Password' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
