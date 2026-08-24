import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import {
  canEdit,
  createVault,
  deleteVault,
  listTrashedVaults,
  listVaults,
  renameVault,
  restoreVault,
} from './vaults'

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

  it('createVault calls POST /api/vaults with the name body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, { id: 'v1', name: 'New', ownerId: 'u1', mergeable: true, access: 'owner' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const vault = await createVault('New')

    expect(vault).toEqual({ id: 'v1', name: 'New', ownerId: 'u1', mergeable: true, access: 'owner' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'New' }) }),
    )
  })

  it('renameVault calls PATCH /api/vaults/:id with the name body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, { id: 'v1', name: 'Renamed', ownerId: 'u1', mergeable: true, access: 'owner' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const vault = await renameVault('v1', 'Renamed')

    expect(vault).toEqual({ id: 'v1', name: 'Renamed', ownerId: 'u1', mergeable: true, access: 'owner' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) }),
    )
  })

  it('deleteVault calls DELETE /api/vaults/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'trashed', id: 'v1' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await deleteVault('v1')

    expect(result).toEqual({ status: 'trashed', id: 'v1' })
    expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('listTrashedVaults calls GET /api/vaults/trash with no method override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, [{ id: 'v1', name: 'Old', deletedAt: '2026-08-01T00:00:00.000Z' }]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const vaults = await listTrashedVaults()

    expect(vaults).toEqual([{ id: 'v1', name: 'Old', deletedAt: '2026-08-01T00:00:00.000Z' }])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/vaults/trash')
    expect(init.method).toBeUndefined()
  })

  it('restoreVault calls POST /api/vaults/:id/restore', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, { id: 'v1', name: 'Old', ownerId: 'u1', mergeable: true, access: 'owner' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const vault = await restoreVault('v1')

    expect(vault).toEqual({ id: 'v1', name: 'Old', ownerId: 'u1', mergeable: true, access: 'owner' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/restore',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('canEdit is true only for edit and owner access', () => {
    expect(canEdit('owner')).toBe(true)
    expect(canEdit('edit')).toBe(true)
    expect(canEdit('read')).toBe(false)
    expect(canEdit(undefined)).toBe(false)
  })
})
