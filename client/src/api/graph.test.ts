import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { fetchGraph } from './graph'

describe('graph api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('all-vaults aggregated, no filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGraph({ vaultId: null, community: null, filters: {} })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/graph/merged?aggregate=community',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('single vault aggregated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGraph({ vaultId: 'v1', community: null, filters: {} })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/graph?aggregate=community',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('single vault expanded to a community sends community, not aggregate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGraph({ vaultId: 'v1', community: 3, filters: {} })

    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('community=3')
    expect(url).not.toContain('aggregate')
  })

  it('expanded with filters serializes types/tags/since', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGraph({
      vaultId: 'v1',
      community: 3,
      filters: { types: ['okf/person'], tags: ['a', 'b'], since: '2026-01-01' },
    })

    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('types=okf%2Fperson')
    expect(url).toContain('tags=a%2Cb')
    expect(url).toContain('since=2026-01-01')
  })

  it('empty types array produces no types key at all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGraph({ vaultId: 'v1', community: null, filters: { types: [] } })

    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).not.toContain('types')
  })
})
