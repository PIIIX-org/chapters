import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { VaultSettingsModal } from './VaultSettingsModal'
import type { Vault } from '../../api/vaults'

const VAULT: Vault = { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: false, access: 'owner' }

function renderModal(vault: Vault = VAULT) {
  const onOpenChange = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <VaultSettingsModal vault={vault} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  )
  return { ...result, onOpenChange }
}

describe('VaultSettingsModal', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a labelled dialog with the vault name in its accessible name', () => {
    renderModal()
    const dialog = screen.getByRole('dialog', { name: /vault settings — engineering/i })
    expect(dialog).toBeInTheDocument()
  })

  it('toggling the switch fires exactly one PATCH to /api/vaults/v1 with { mergeable: true }', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(mockJsonResponse(200, { ...VAULT, mergeable: true })))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderModal()

    await user.click(screen.getByRole('switch', { name: 'Mergeable' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/vaults/v1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ mergeable: true })
  })

  it('shows the off-state consequence copy when mergeable is false', () => {
    renderModal({ ...VAULT, mergeable: false })
    expect(
      screen.getByText("This vault stays out of everyone's merged graph view, including your own."),
    ).toBeInTheDocument()
  })

  it('shows the on-state consequence copy when mergeable is true', () => {
    renderModal({ ...VAULT, mergeable: true })
    expect(
      screen.getByText('Anyone this vault is shared with can fold its notes into their own merged graph view.'),
    ).toBeInTheDocument()
  })

  it('rolls back the switch and shows an error when the PATCH fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(mockJsonResponse(500, { error: 'Internal error' }))),
    )
    const user = userEvent.setup()
    const { container } = renderModal()
    const toggle = screen.getByRole('switch', { name: 'Mergeable' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await user.click(toggle)

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Internal error'))
    // Must not sit "on" after a failed write.
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(
      screen.getByText("This vault stays out of everyone's merged graph view, including your own."),
    ).toBeInTheDocument()

    await expectNoA11yViolations(container)
  })

  it('has no accessibility violations in the open, happy-path state', async () => {
    const { container } = renderModal()
    await expectNoA11yViolations(container)
  })
})
