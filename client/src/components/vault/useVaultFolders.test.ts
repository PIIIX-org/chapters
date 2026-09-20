import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { mockJsonResponse } from '../../lib/api'
import { useVaultFolders } from './useVaultFolders'

describe('useVaultFolders', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('initializes with default online storage mode and empty data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/api/me/vault-preferences') {
          return Promise.resolve(
            mockJsonResponse(200, {
              storageMode: 'online',
              folders: {},
              folderColors: {},
              vaultColors: {},
              favorites: {},
            }),
          )
        }
        return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
      }),
    )

    const { result } = renderHook(() => useVaultFolders())

    expect(result.current.storageMode).toBe('online')
    expect(result.current.folders).toEqual({})
    expect(result.current.allFolders).toEqual([])
  })

  it('fetches and populates remote folders and colors on mount when online', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === '/api/me/vault-preferences') {
          return Promise.resolve(
            mockJsonResponse(200, {
              storageMode: 'online',
              folders: { v1: 'Work', v2: 'Personal' },
              folderColors: { Work: 'blue' },
              vaultColors: { v1: 'rose' },
              favorites: { v1: true },
            }),
          )
        }
        return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
      }),
    )

    const { result } = renderHook(() => useVaultFolders())

    await vi.waitFor(() => {
      expect(result.current.folders).toEqual({ v1: 'Work', v2: 'Personal' })
    })

    expect(result.current.allFolders).toEqual(['Personal', 'Work'])
    expect(result.current.getVaultFolder('v1')).toBe('Work')
    expect(result.current.getFolderColor('Work')).toBe('blue')
    expect(result.current.getVaultColor('v1')).toBe('rose')
    expect(result.current.isFavorite('v1')).toBe(true)
  })

  it('persists changes locally and pushes to server when online', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/me/vault-preferences') {
        return Promise.resolve(
          mockJsonResponse(200, {
            storageMode: 'online',
            folders: {},
            folderColors: {},
            vaultColors: {},
            favorites: {},
          }),
        )
      }
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useVaultFolders())

    act(() => {
      result.current.setVaultFolder('v1', 'Engineering')
      result.current.setFolderColor('Engineering', 'emerald')
    })

    expect(result.current.getVaultFolder('v1')).toBe('Engineering')
    expect(result.current.getFolderColor('Engineering')).toBe('emerald')

    // Verify localStorage has the changes
    expect(JSON.parse(localStorage.getItem('chapters_vault_folders') || '{}')).toEqual({
      v1: 'Engineering',
    })
  })

  it('allows switching storageMode to local and back to online', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/me/vault-preferences') {
        return Promise.resolve(
          mockJsonResponse(200, {
            storageMode: 'online',
            folders: {},
            folderColors: {},
            vaultColors: {},
            favorites: {},
          }),
        )
      }
      return Promise.resolve(mockJsonResponse(404, { error: 'not found' }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useVaultFolders())

    await act(async () => {
      await result.current.setStorageMode('local')
    })

    expect(result.current.storageMode).toBe('local')
    expect(JSON.parse(localStorage.getItem('chapters_vault_storage_mode') || '""')).toBe('local')

    await act(async () => {
      await result.current.setStorageMode('online')
    })

    expect(result.current.storageMode).toBe('online')
    expect(JSON.parse(localStorage.getItem('chapters_vault_storage_mode') || '""')).toBe('online')
  })
})
