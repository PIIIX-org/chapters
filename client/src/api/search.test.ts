import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { search } from './search'

describe('search api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GETs /api/search with query, limit, and filters (everywhere scope)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, [
        { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'people/jane', snippet: '…jane…', score: 0.9 },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const results = await search('jane doe', {
      limit: 10,
      filters: { types: ['people'], tags: ['a', 'b'], since: '2026-01-01' },
    })

    expect(results[0]!.path).toBe('people/jane')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/search?q=jane%20doe&limit=10&types=people&tags=a,b&since=2026-01-01',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('scopes the request to a vault when vaultId is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await search('jane doe', { vaultId: 'v2' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v2/search?q=jane%20doe&limit=20',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('omits filter keys entirely when there are no filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await search('jane doe')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/search?q=jane%20doe&limit=20',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
