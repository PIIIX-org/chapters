import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { HomePage } from './HomePage'

describe('HomePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("greets the logged-in user's email", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { id: 'u1', email: 'taha@piiix.org', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      ),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())
  })
})
