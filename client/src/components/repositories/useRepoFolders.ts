import { useCallback, useState } from 'react'
import type { VaultColor } from '../vault/useVaultFolders.js'

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage write errors (e.g. quota exceeded or private mode)
  }
}

export function useRepoFolders() {
  const storageKeyFolders = 'chapters_repo_folders'
  const storageKeyFolderColors = 'chapters_repo_folder_colors'
  const storageKeyRepoColors = 'chapters_repo_colors'
  const storageKeyFavorites = 'chapters_repo_favorites'

  const [repoFolders, setRepoFolders] = useState<Record<string, string>>(() =>
    readStorage(storageKeyFolders, {}),
  )
  const [folderColors, setFolderColors] = useState<Record<string, VaultColor>>(() =>
    readStorage(storageKeyFolderColors, {}),
  )
  const [repoColors, setRepoColors] = useState<Record<string, VaultColor>>(() =>
    readStorage(storageKeyRepoColors, {}),
  )
  const [favorites, setFavorites] = useState<string[]>(() =>
    readStorage(storageKeyFavorites, []),
  )

  const setRepoFolder = useCallback(
    (
      repoId: string,
      folder: string,
      repoColor?: VaultColor,
      folderColor?: VaultColor,
    ) => {
      setRepoFolders((prev) => {
        const next = { ...prev }
        if (folder.trim()) {
          next[repoId] = folder.trim()
        } else {
          delete next[repoId]
        }
        writeStorage(storageKeyFolders, next)
        return next
      })

      if (folder.trim() && folderColor !== undefined) {
        setFolderColors((prev) => {
          const next = { ...prev }
          if (folderColor) {
            next[folder.trim().toLowerCase()] = folderColor
          } else {
            delete next[folder.trim().toLowerCase()]
          }
          writeStorage(storageKeyFolderColors, next)
          return next
        })
      }

      setRepoColors((prev) => {
        const next = { ...prev }
        if (repoColor) {
          next[repoId] = repoColor
        } else {
          delete next[repoId]
        }
        writeStorage(storageKeyRepoColors, next)
        return next
      })
    },
    [storageKeyFolders, storageKeyFolderColors, storageKeyRepoColors],
  )

  const getRepoFolder = useCallback(
    (repoId: string): string => {
      return repoFolders[repoId] || ''
    },
    [repoFolders],
  )

  const getFolderColor = useCallback(
    (folder: string): VaultColor | undefined => {
      if (!folder) return undefined
      return folderColors[folder.trim().toLowerCase()]
    },
    [folderColors],
  )

  const getRepoColor = useCallback(
    (repoId: string): VaultColor | undefined => {
      return repoColors[repoId]
    },
    [repoColors],
  )

  const isFavorite = useCallback(
    (repoId: string): boolean => {
      return favorites.includes(repoId)
    },
    [favorites],
  )

  const toggleFavorite = useCallback(
    (repoId: string) => {
      setFavorites((prev) => {
        const next = prev.includes(repoId)
          ? prev.filter((id) => id !== repoId)
          : [...prev, repoId]
        writeStorage(storageKeyFavorites, next)
        return next
      })
    },
    [storageKeyFavorites],
  )

  const allFolders = Array.from(
    new Set(Object.values(repoFolders).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b))

  return {
    repoFolders,
    folderColors,
    repoColors,
    favorites,
    setRepoFolder,
    getRepoFolder,
    getFolderColor,
    getRepoColor,
    isFavorite,
    toggleFavorite,
    allFolders,
  }
}
