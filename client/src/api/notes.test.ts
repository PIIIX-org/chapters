import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { getNote, getVaultTree } from './notes'

describe('notes api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getVaultTree calls GET /api/vaults/:id/tree', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, {
        people: [
          { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, updatedAt: '2026-01-01' },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tree = await getVaultTree('v1')

    expect(tree.people).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v1/tree', expect.objectContaining({ credentials: 'include' }))
  })

  it('getNote calls GET /api/vaults/:id/notes/:path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, {
        path: 'people/jane',
        frontmatter: { type: 'people' },
        body: '# Jane\n\nNotes here.',
        updatedAt: '2026-01-01',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const note = await getNote('v1', 'people/jane')

    expect(note.body).toBe('# Jane\n\nNotes here.')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/notes/people/jane',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
