import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../../lib/api'
import { expectNoA11yViolations } from '../../test/axe'
import { NewVaultForm } from './NewVaultForm'

function renderForm(onCreated = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <NewVaultForm onCreated={onCreated} />
    </QueryClientProvider>,
  )
  return { ...result, onCreated }
}

describe('NewVaultForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a vault and calls onCreated with the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(201, { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' }),
      ),
    )
    const { onCreated } = renderForm()

    fireEvent.change(screen.getByLabelText('Vault name'), { target: { value: 'Engineering' } })
    fireEvent.click(screen.getByRole('button', { name: /create vault/i }))

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'v1', name: 'Engineering' }),
      ),
    )

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Engineering' }) }),
    )
  })

  it('rejects a blank name before calling the server', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderForm()

    fireEvent.change(screen.getByLabelText('Vault name'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: /create vault/i }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Give the vault a name.')
  })

  it('rejects a name over 200 characters before calling the server', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderForm()

    fireEvent.change(screen.getByLabelText('Vault name'), { target: { value: 'a'.repeat(201) } })
    fireEvent.click(screen.getByRole('button', { name: /create vault/i }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('A vault name can be at most 200 characters.')
  })

  it('shows the server error message on a collision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(409, { error: 'a vault named Engineering already exists' })),
    )
    renderForm()

    fireEvent.change(screen.getByLabelText('Vault name'), { target: { value: 'Engineering' } })
    fireEvent.click(screen.getByRole('button', { name: /create vault/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('a vault named Engineering already exists'))
  })

  it('has no accessibility violations', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { container } = renderForm()
    await expectNoA11yViolations(container)
  })
})
