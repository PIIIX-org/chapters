import { useCallback, useState } from 'react'
import type { VaultColor } from './useVaultFolders.js'

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

export function useNoteFolders(vaultId: string) {
  const storageKeyFolders = `chapters_note_folders_${vaultId}`
  const storageKeyFolderColors = `chapters_note_folder_colors_${vaultId}`
  const storageKeyNoteColors = `chapters_note_colors_${vaultId}`
  const storageKeyFavorites = `chapters_note_favorites_${vaultId}`

  const [noteFolders, setNoteFolders] = useState<Record<string, string>>(() =>
    readStorage(storageKeyFolders, {}),
  )
  const [folderColors, setFolderColors] = useState<Record<string, VaultColor>>(() =>
    readStorage(storageKeyFolderColors, {}),
  )
  const [noteColors, setNoteColors] = useState<Record<string, VaultColor>>(() =>
    readStorage(storageKeyNoteColors, {}),
  )
  const [favorites, setFavorites] = useState<string[]>(() =>
    readStorage(storageKeyFavorites, []),
  )

  const setNoteFolder = useCallback(
    (
      noteId: string,
      folder: string,
      noteColor?: VaultColor,
      folderColor?: VaultColor,
    ) => {
      setNoteFolders((prev) => {
        const next = { ...prev }
        if (folder.trim()) {
          next[noteId] = folder.trim()
        } else {
          delete next[noteId]
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

      setNoteColors((prev) => {
        const next = { ...prev }
        if (noteColor) {
          next[noteId] = noteColor
        } else {
          delete next[noteId]
        }
        writeStorage(storageKeyNoteColors, next)
        return next
      })
    },
    [storageKeyFolders, storageKeyFolderColors, storageKeyNoteColors],
  )

  const getNoteFolder = useCallback(
    (noteId: string, notePath: string, noteType?: string): string => {
      if (noteFolders[noteId]) return noteFolders[noteId]
      if (notePath.includes('/')) {
        return notePath.split('/')[0] || ''
      }
      if (noteType && noteType !== 'note') {
        return noteType
      }
      return ''
    },
    [noteFolders],
  )

  const getFolderColor = useCallback(
    (folder: string): VaultColor | undefined => {
      if (!folder) return undefined
      return folderColors[folder.trim().toLowerCase()]
    },
    [folderColors],
  )

  const getNoteColor = useCallback(
    (noteId: string): VaultColor | undefined => {
      return noteColors[noteId]
    },
    [noteColors],
  )

  const isFavorite = useCallback(
    (noteId: string): boolean => {
      return favorites.includes(noteId)
    },
    [favorites],
  )

  const toggleFavorite = useCallback(
    (noteId: string) => {
      setFavorites((prev) => {
        const next = prev.includes(noteId)
          ? prev.filter((id) => id !== noteId)
          : [...prev, noteId]
        writeStorage(storageKeyFavorites, next)
        return next
      })
    },
    [storageKeyFavorites],
  )

  const allFolders = Array.from(
    new Set([
      ...Object.values(noteFolders),
      ...Object.keys(folderColors),
    ]),
  ).filter(Boolean)

  return {
    getNoteFolder,
    getFolderColor,
    getNoteColor,
    setNoteFolder,
    isFavorite,
    toggleFavorite,
    allFolders,
  }
}
