import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, MemoryRouter, RouterProvider, useSearchParams } from 'react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { ScopePicker } from './ScopePicker'

// Two distinctly named vaults on purpose: a one-vault fixture would let a
// picker that always selects the first entry pass.
const VAULTS = [
  { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
  { id: 'v2', name: 'Recipes', ownerId: 'u1', mergeable: true, access: 'owner' },
]

function LocationProbe() {
  const [params] = useSearchParams()
  return <div data-testid="vault-param">{params.get('vault') ?? ''}</div>
}

function renderPicker(initialEntry = '/') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/trash')) return Promise.resolve(mockJsonResponse(200, []))
      return Promise.resolve(mockJsonResponse(200, VAULTS))
    }),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ScopePicker />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ScopePicker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads All vaults initially, closed', async () => {
    renderPicker()
    const trigger = await screen.findByRole('button', { name: 'All vaults' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens to list both vaults as options', async () => {
    renderPicker()
    const trigger = await screen.findByRole('button', { name: 'All vaults' })
    await waitFor(() => expect(trigger).not.toBeDisabled())

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('option', { name: 'All vaults' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Engineering' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Recipes' })).toBeInTheDocument()
  })

  it('selecting a vault sets the URL param, updates the label, and closes', async () => {
    renderPicker()
    const trigger = await screen.findByRole('button', { name: 'All vaults' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    fireEvent.click(trigger)

    fireEvent.click(screen.getByRole('option', { name: 'Recipes' }))

    await waitFor(() => expect(screen.getByTestId('vault-param')).toHaveTextContent('v2'))
    expect(screen.getByRole('button', { name: 'Recipes' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('reads the vault param from the URL on mount', async () => {
    renderPicker('/?vault=v1')
    expect(await screen.findByRole('button', { name: 'Engineering' })).toBeInTheDocument()
  })

  it('falls back to All vaults for an id the user cannot see', async () => {
    const trigger = renderPicker('/?vault=ghost').getByRole('button')
    await waitFor(() => expect(trigger).not.toBeDisabled())
    expect(trigger).toHaveTextContent('All vaults')
  })

  it('Escape closes the list and returns focus to the trigger', async () => {
    renderPicker()
    const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: 'All vaults' })
    await waitFor(() => expect(trigger).not.toBeDisabled())

    // Drive this from a real user interaction, not a synthetic event fired
    // straight at the handler's own node: after a real click, focus sits on
    // the trigger (a sibling of the popup), so Escape must bubble from there
    // to close the picker. Dispatching keyDown on the listbox directly would
    // pass even if the handler were unreachable from the trigger.
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('{Escape}')

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
  })

  it('has no accessibility violations while open', async () => {
    const { container } = renderPicker()
    const trigger = await screen.findByRole('button', { name: 'All vaults' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    fireEvent.click(trigger)

    await expectNoA11yViolations(container)
  })

  it('shows owner row actions for the selected vault, without repeating its name in the option list', async () => {
    renderPicker()
    const trigger = await screen.findByRole('button', { name: 'All vaults' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    fireEvent.click(trigger)

    // Nothing selected yet: no rename/delete for either vault.
    expect(screen.queryByRole('button', { name: /rename engineering/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: 'Engineering' }))
    fireEvent.click(screen.getByRole('button', { name: 'Engineering' })) // reopen after select closed it

    expect(screen.getByRole('option', { name: 'Engineering' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /rename engineering/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete engineering/i })).toBeInTheDocument()
    // "Engineering" now legitimately appears three times (trigger label,
    // the listbox option, and the action strip's name) — but never as a
    // second, redundant row inside the action strip itself.
    expect(screen.getAllByText('Engineering')).toHaveLength(3)
    // Selecting Recipes instead must not carry Engineering's actions along.
    fireEvent.click(screen.getByRole('option', { name: 'Recipes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Recipes' }))
    expect(screen.queryByRole('button', { name: /rename engineering/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /rename recipes/i })).toBeInTheDocument()
  })

  it('Vault settings is owner-only: shown for an owned active vault, absent for a read-access one', async () => {
    const mixedAccess = [
      { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
      { id: 'v2', name: 'Shared Notes', ownerId: 'u2', mergeable: true, access: 'read' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/trash')) return Promise.resolve(mockJsonResponse(200, []))
        return Promise.resolve(mockJsonResponse(200, mixedAccess))
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/?vault=v1']}>
          <ScopePicker />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const trigger = await screen.findByRole('button', { name: 'Engineering' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    fireEvent.click(trigger)

    expect(screen.getByRole('button', { name: 'Vault settings' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: 'Shared Notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Shared Notes' }))

    expect(screen.queryByRole('button', { name: 'Vault settings' })).not.toBeInTheDocument()
  })

  // The settings modal pulls in SharingPanel, VaultMcpPanel and
  // VaultExportPanel, each firing its own GET on mount — stub them to a
  // quiet empty state so these tests stay about the modal/dropdown
  // interaction, not those panels' own content.
  function stubFetchWithSettingsModal() {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/trash')) return Promise.resolve(mockJsonResponse(200, []))
      if (url.includes('/shares')) return Promise.resolve(mockJsonResponse(200, []))
      if (url.includes('/teams')) return Promise.resolve(mockJsonResponse(200, []))
      if (url.includes('/mcp-connections')) return Promise.resolve(mockJsonResponse(200, []))
      if (url.includes('/vaults')) return Promise.resolve(mockJsonResponse(200, VAULTS))
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  it('clicking Vault settings actually opens the dialog', async () => {
    stubFetchWithSettingsModal()
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/?vault=v1']}>
          <ScopePicker />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const trigger = await screen.findByRole('button', { name: 'Engineering' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    await user.click(trigger)

    await user.click(screen.getByRole('button', { name: 'Vault settings' }))

    expect(await screen.findByRole('dialog', { name: /vault settings — engineering/i })).toBeInTheDocument()
  })

  it('Escape inside the vault settings modal closes only the modal, leaving the dropdown behind it open', async () => {
    stubFetchWithSettingsModal()
    const user = userEvent.setup()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/?vault=v1']}>
          <ScopePicker />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const trigger = await screen.findByRole('button', { name: 'Engineering' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    await user.click(trigger)
    const settingsButton = screen.getByRole('button', { name: 'Vault settings' })
    await user.click(settingsButton)
    await screen.findByRole('dialog', { name: /vault settings — engineering/i })

    await user.keyboard('{Escape}')

    // The modal is gone...
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // ...but one Escape must not also collapse the dropdown behind it: the
    // trigger stays expanded and the "Vault settings" button — the exact
    // element Radix restores focus to on unmount — is still in the DOM and
    // focusable, not yanked out from under the focus restore.
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Vault settings' })).toBeInTheDocument()
  })

  it('New vault is reachable from the picker and navigates to the created vault', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          mockJsonResponse(201, { id: 'v9', name: 'Personal', ownerId: 'u1', mergeable: true, access: 'owner' }),
        )
      }
      if (url.endsWith('/trash')) return Promise.resolve(mockJsonResponse(200, []))
      return Promise.resolve(mockJsonResponse(200, VAULTS))
    })
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const router = createMemoryRouter(
      [
        { path: '/', element: <ScopePicker /> },
        { path: '/vaults/:vaultId', element: <div>vault v9 loaded</div> },
      ],
      { initialEntries: ['/'] },
    )
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )

    const trigger = await screen.findByRole('button', { name: 'All vaults' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '+ New vault' }))
    fireEvent.change(screen.getByLabelText('Vault name'), { target: { value: 'Personal' } })
    fireEvent.click(screen.getByRole('button', { name: /create vault/i }))

    await waitFor(() => expect(screen.getByText('vault v9 loaded')).toBeInTheDocument())
  })
})
