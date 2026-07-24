import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../../lib/api'
import { PropertyPanel } from './PropertyPanel'

function renderPanel(frontmatter: Record<string, unknown>, readOnly = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <PropertyPanel vaultId="v1" path="people/jane" initialFrontmatter={frontmatter} readOnly={readOnly} />
    </QueryClientProvider>,
  )
}

function putBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string))
}

describe('PropertyPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shows type read-only and renders the standard fields', () => {
    renderPanel({ type: 'people', resource: 'https://x.test', tags: ['a'], timestamp: '2026-01-01' })
    // type shown but not as an editable input
    expect(screen.getByText('people')).toBeInTheDocument()
    expect(screen.getByDisplayValue('https://x.test')).toBeInTheDocument()
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByDisplayValue('2026-01-01')).toBeInTheDocument()
  })

  it('debounce-saves the full frontmatter, preserving type and extra keys, when resource changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'n1', path: 'people/jane', frontmatter: {}, body: '', updatedAt: '2026-01-02' }))
    vi.stubGlobal('fetch', fetchMock)

    renderPanel({ type: 'people', resource: 'old', tags: ['a'], timestamp: '2026-01-01', custom: 'keep' })

    fireEvent.change(screen.getByDisplayValue('old'), { target: { value: 'new' } })

    await vi.advanceTimersByTimeAsync(500)
    expect(putBodies(fetchMock)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(800)
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
    expect(putBodies(fetchMock)[0]).toEqual({
      frontmatter: { type: 'people', custom: 'keep', resource: 'new', tags: ['a'], timestamp: '2026-01-01' },
    })
  })

  it('omits emptied optional keys from the saved frontmatter', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'n1', path: 'people/jane', frontmatter: {}, body: '', updatedAt: '2026-01-02' }))
    vi.stubGlobal('fetch', fetchMock)

    renderPanel({ type: 'people', resource: 'old' })

    fireEvent.change(screen.getByDisplayValue('old'), { target: { value: '' } })
    await vi.advanceTimersByTimeAsync(1300)

    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
    expect(putBodies(fetchMock)[0]).toEqual({ frontmatter: { type: 'people' } })
  })

  it('disables fields and never saves when readOnly', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    renderPanel({ type: 'people', resource: 'ro' }, true)

    const resourceInput = screen.getByDisplayValue('ro') as HTMLInputElement
    expect(resourceInput.disabled).toBe(true)
    // A change that slips through must not schedule a save.
    fireEvent.change(resourceInput, { target: { value: 'x' } })
    await vi.advanceTimersByTimeAsync(1300)
    expect(putBodies(fetchMock)).toHaveLength(0)
  })
})
