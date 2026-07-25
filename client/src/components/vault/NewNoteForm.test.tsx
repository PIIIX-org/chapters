import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../../lib/api'
import { NewNoteForm } from './NewNoteForm'

function renderForm(onCreated = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <NewNoteForm vaultId="v1" existingTypes={['people']} onCreated={onCreated} />
    </QueryClientProvider>,
  )
}

describe('NewNoteForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects an invalid slug before calling the server', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderForm()

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'People!' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'jane' } })
    fireEvent.click(screen.getByRole('button', { name: /create note/i }))

    expect(screen.getByText(/type must be/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates a note and calls onCreated with the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(201, { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, body: '', updatedAt: '2026-01-01' }),
      ),
    )
    const onCreated = vi.fn()
    renderForm(onCreated)

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'people' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'jane' } })
    fireEvent.click(screen.getByRole('button', { name: /create note/i }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ path: 'people/jane' })))
  })

  it('shows the server error message on a collision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(409, { error: 'a note already exists at people/jane' })),
    )
    renderForm()

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'people' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'jane' } })
    fireEvent.click(screen.getByRole('button', { name: /create note/i }))

    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeInTheDocument())
  })
})
