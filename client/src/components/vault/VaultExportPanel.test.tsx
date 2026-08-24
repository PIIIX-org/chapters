import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { VaultExportPanel } from './VaultExportPanel'

const LINK_RESPONSE = { id: 'l1', token: 'raw-export-token', expiresAt: '2026-08-24T12:00:00.000Z' }

// Every test builds a fresh Response per call — this panel both creates and
// revokes, and mockResolvedValue would hand back the same drained Response
// body across those calls.
function stubFetch(opts: { createStatus?: number; createBody?: unknown } = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/vaults/v1/export-links' && init?.method === 'POST') {
      return Promise.resolve(
        mockJsonResponse(opts.createStatus ?? 200, opts.createBody ?? LINK_RESPONSE),
      )
    }
    if (url === '/api/vaults/v1/export-links/l1' && init?.method === 'DELETE') {
      return Promise.resolve(mockJsonResponse(200, { status: 'revoked' }))
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('VaultExportPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('the zip download is a plain anchor with the exact href and download attribute, not a fetch call', () => {
    stubFetch()
    render(<VaultExportPanel vaultId="v1" />)

    const link = screen.getByRole('link', { name: 'Download a zip of this vault' })
    expect(link).toHaveAttribute('href', '/api/vaults/v1/export')
    expect(link).toHaveAttribute('download')
  })

  it('create POSTs export-links with no required body and reveals the sessionless URL', async () => {
    const fetchMock = stubFetch()
    const user = userEvent.setup()
    render(<VaultExportPanel vaultId="v1" />)

    await user.click(screen.getByRole('button', { name: 'Create a shareable link' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/vaults/v1/export-links',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const [, init] = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/vaults/v1/export-links',
    ) as [string, RequestInit]
    expect(init.body).toBeUndefined()

    const expectedUrl = `${window.location.origin}/api/export-links/raw-export-token`
    expect(await screen.findByText(expectedUrl)).toBeInTheDocument()
  })

  it("the reveal names the formatted expiresAt and says no sign-in is needed", async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<VaultExportPanel vaultId="v1" />)

    await user.click(screen.getByRole('button', { name: 'Create a shareable link' }))

    const formatted = new Date(LINK_RESPONSE.expiresAt).toLocaleString()
    expect(await screen.findByText(new RegExp(`without signing in, until ${formatted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeInTheDocument()
  })

  it('revoke requires an inline confirm naming the consequence, then DELETEs by link id (not token)', async () => {
    const fetchMock = stubFetch()
    const user = userEvent.setup()
    render(<VaultExportPanel vaultId="v1" />)

    await user.click(screen.getByRole('button', { name: 'Create a shareable link' }))
    await screen.findByText(`${window.location.origin}/api/export-links/raw-export-token`)

    await user.click(screen.getByRole('button', { name: 'Revoke link' }))

    // First click must not fire a request yet.
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'DELETE')).toBe(false)

    const confirmText = await screen.findByText(/Revoke this link\?/)
    expect(confirmText).toHaveTextContent(/stops working immediately/)
    expect(confirmText).toHaveTextContent(/not cancelled/)

    await user.click(screen.getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/vaults/v1/export-links/l1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    )
    expect(fetchMock.mock.calls.some((c) => (c[0] as string).includes('raw-export-token'))).toBe(false)
  })

  it('a failed create renders an inline error and no reveal appears', async () => {
    stubFetch({ createStatus: 500, createBody: { error: 'boom' } })
    const user = userEvent.setup()
    render(<VaultExportPanel vaultId="v1" />)

    await user.click(screen.getByRole('button', { name: 'Create a shareable link' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Shareable export link')).toBeNull()
    expect(screen.queryByText(/undefined/)).toBeNull()
  })

  it('has no accessibility violations in the loaded state', async () => {
    stubFetch()
    const user = userEvent.setup()
    const { container } = render(<VaultExportPanel vaultId="v1" />)

    await user.click(screen.getByRole('button', { name: 'Create a shareable link' }))
    await screen.findByText(`${window.location.origin}/api/export-links/raw-export-token`)

    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations in the error state', async () => {
    stubFetch({ createStatus: 500, createBody: { error: 'boom' } })
    const user = userEvent.setup()
    const { container } = render(<VaultExportPanel vaultId="v1" />)

    await user.click(screen.getByRole('button', { name: 'Create a shareable link' }))
    await screen.findByRole('alert')

    await expectNoA11yViolations(container)
  })
})
