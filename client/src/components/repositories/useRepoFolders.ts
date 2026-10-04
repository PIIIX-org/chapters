import { useCallback, useState } from 'react'
import type { VaultColor } from '../vault/useVaultFolders.js'
import { getMigratedStorageItem } from '../../lib/storage.js'

export const STORAGE_KEY_REPO_FOLDERS = 'elara_repo_folders'
export const LEGACY_STORAGE_KEY_REPO_FOLDERS = 'chapters_repo_folders'
export const STORAGE_KEY_REPO_FOLDER_COLORS = 'elara_repo_folder_colors'
export const LEGACY_STORAGE_KEY_REPO_FOLDER_COLORS = 'chapters_repo_folder_colors'
export const STORAGE_KEY_REPO_COLORS = 'elara_repo_colors'
export const LEGACY_STORAGE_KEY_REPO_COLORS = 'chapters_repo_colors'
export const STORAGE_KEY_REPO_FAVORITES = 'elara_repo_favorites'
export const LEGACY_STORAGE_KEY_REPO_FAVORITES = 'chapters_repo_favorites'

function readStorage<T>(key: string, legacyKey: string, fallback: T): T {
  try {
    const raw = getMigratedStorageItem(key, legacyKey)
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
  const [repoFolders, setRepoFolders] = useState<Record<string, string>>(() =>
    readStorage(STORAGE_KEY_REPO_FOLDERS, LEGACY_STORAGE_KEY_REPO_FOLDERS, {}),
  )
  const [folderColors, setFolderColors] = useState<Record<string, VaultColor>>(() =>
    readStorage(STORAGE_KEY_REPO_FOLDER_COLORS, LEGACY_STORAGE_KEY_REPO_FOLDER_COLORS, {}),
  )
  const [repoColors, setRepoColors] = useState<Record<string, VaultColor>>(() =>
    readStorage(STORAGE_KEY_REPO_COLORS, LEGACY_STORAGE_KEY_REPO_COLORS, {}),
  )
  const [favorites, setFavorites] = useState<string[]>(() =>
    readStorage(STORAGE_KEY_REPO_FAVORITES, LEGACY_STORAGE_KEY_REPO_FAVORITES, []),
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
        writeStorage(STORAGE_KEY_REPO_FOLDERS, next)
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
          writeStorage(STORAGE_KEY_REPO_FOLDER_COLORS, next)
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
        writeStorage(STORAGE_KEY_REPO_COLORS, next)
        return next
      })
    },
    [],
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
        writeStorage(STORAGE_KEY_REPO_FAVORITES, next)
        return next
      })
    },
    [],
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
