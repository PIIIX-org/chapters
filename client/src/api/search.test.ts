import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { search } from './search'

describe('search api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GETs /api/search with the url-encoded query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, [
        { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'people/jane', snippet: '…jane…', score: 0.9 },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const results = await search('jane doe', 10)

    expect(results[0]!.path).toBe('people/jane')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/search?q=jane%20doe&limit=10',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
