import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useSearchParams } from 'react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, VAULTS)))
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
    const trigger = await screen.findByRole('button', { name: 'All vaults' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })

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
})
