import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { canEdit, getVaultAccess, listVaults } from './vaults'

describe('vaults api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listVaults calls GET /api/vaults', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, [
        { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const vaults = await listVaults()

    expect(vaults).toEqual([
      { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' },
    ])
    expect(fetchMock).toHaveBeenCalledWith('/api/vaults', expect.objectContaining({ credentials: 'include' }))
  })

  it('getVaultAccess calls GET /api/vaults/:id/access', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { access: 'edit' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await getVaultAccess('v1')

    expect(result).toEqual({ access: 'edit' })
    expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v1/access', expect.objectContaining({ credentials: 'include' }))
  })

  it('canEdit is true only for edit and owner access', () => {
    expect(canEdit('owner')).toBe(true)
    expect(canEdit('edit')).toBe(true)
    expect(canEdit('read')).toBe(false)
    expect(canEdit(undefined)).toBe(false)
  })
})
