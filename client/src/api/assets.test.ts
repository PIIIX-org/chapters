import { describe, expect, it, vi } from 'vitest'
import { listAssets, uploadAsset } from './assets.js'

describe('assets client API', () => {
  it('uploads an asset via multipart formData', async () => {
    const mockAsset = {
      fileName: 'screenshot-123.png',
      url: '/api/vaults/v1/assets/screenshot-123.png',
      path: 'assets/screenshot-123.png',
      size: 42,
      mimeType: 'image/png',
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockAsset,
    })
    globalThis.fetch = mockFetch

    const file = new File(['content'], 'screenshot.png', { type: 'image/png' })
    const res = await uploadAsset('v1', file)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/vaults/v1/assets')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.body).toBeInstanceOf(FormData)
    expect(res).toEqual(mockAsset)
  })

  it('throws descriptive error on upload failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'File too large' }),
    })
    globalThis.fetch = mockFetch

    const file = new File(['content'], 'big.png', { type: 'image/png' })
    await expect(uploadAsset('v1', file)).rejects.toThrow('File too large')
  })

  it('lists assets for a vault', async () => {
    const mockList = {
      assets: [{ fileName: 'photo.jpg', size: 1024, modifiedAt: '2026-09-27T00:00:00Z' }],
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockList,
    })
    globalThis.fetch = mockFetch

    const res = await listAssets('v1')
    expect(res).toEqual(mockList)
  })
})
