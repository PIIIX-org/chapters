import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  getVaultUserPreferences,
  updateVaultUserPreferences,
} from '../../api/vaults.js'

export type VaultColor =
  | 'blue'
  | 'emerald'
  | 'amber'
  | 'purple'
  | 'rose'
  | 'cyan'
  | 'orange'
  | 'slate'
  | (string & {})

export interface ColorDef {
  id: string
  label: string
  accent: string // e.g. solid color for dots/bars
  badge: string // for pills/badges
  cardBorder: string // for card borders
  cardTopBar: string // for top accent line
  folderTab: string // for folder tabs
  folderBg: string // for folder container background
  folderIcon: string // for folder icon text color
  style?: {
    accent?: CSSProperties
    badge?: CSSProperties
    cardBorder?: CSSProperties
    cardTopBar?: CSSProperties
    folderTab?: CSSProperties
    folderBg?: CSSProperties
    folderIcon?: CSSProperties
  }
}

export const COLOR_PALETTE: ColorDef[] = [
  {
    id: 'blue',
    label: 'Blue',
    accent: 'bg-blue-500',
    badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
    cardBorder: 'border-blue-500/30 hover:border-blue-500/60',
    cardTopBar: 'bg-blue-500',
    folderTab: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40',
    folderBg: 'bg-blue-500/5',
    folderIcon: 'text-blue-500',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    accent: 'bg-emerald-500',
    badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    cardBorder: 'border-emerald-500/30 hover:border-emerald-500/60',
    cardTopBar: 'bg-emerald-500',
    folderTab: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
    folderBg: 'bg-emerald-500/5',
    folderIcon: 'text-emerald-500',
  },
  {
    id: 'amber',
    label: 'Amber',
    accent: 'bg-amber-500',
    badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    cardBorder: 'border-amber-500/30 hover:border-amber-500/60',
    cardTopBar: 'bg-amber-500',
    folderTab: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40',
    folderBg: 'bg-amber-500/5',
    folderIcon: 'text-amber-500',
  },
  {
    id: 'purple',
    label: 'Purple',
    accent: 'bg-purple-500',
    badge: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
    cardBorder: 'border-purple-500/30 hover:border-purple-500/60',
    cardTopBar: 'bg-purple-500',
    folderTab: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40',
    folderBg: 'bg-purple-500/5',
    folderIcon: 'text-purple-500',
  },
  {
    id: 'rose',
    label: 'Rose',
    accent: 'bg-rose-500',
    badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30',
    cardBorder: 'border-rose-500/30 hover:border-rose-500/60',
    cardTopBar: 'bg-rose-500',
    folderTab: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/40',
    folderBg: 'bg-rose-500/5',
    folderIcon: 'text-rose-500',
  },
  {
    id: 'cyan',
    label: 'Cyan',
    accent: 'bg-cyan-500',
    badge: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30',
    cardBorder: 'border-cyan-500/30 hover:border-cyan-500/60',
    cardTopBar: 'bg-cyan-500',
    folderTab: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/40',
    folderBg: 'bg-cyan-500/5',
    folderIcon: 'text-cyan-500',
  },
  {
    id: 'orange',
    label: 'Orange',
    accent: 'bg-orange-500',
    badge: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
    cardBorder: 'border-orange-500/30 hover:border-orange-500/60',
    cardTopBar: 'bg-orange-500',
    folderTab: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40',
    folderBg: 'bg-orange-500/5',
    folderIcon: 'text-orange-500',
  },
  {
    id: 'slate',
    label: 'Slate',
    accent: 'bg-slate-500',
    badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30',
    cardBorder: 'border-slate-500/30 hover:border-slate-500/60',
    cardTopBar: 'bg-slate-500',
    folderTab: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/40',
    folderBg: 'bg-slate-500/5',
    folderIcon: 'text-slate-500',
  },
]

export function getColorDef(color?: VaultColor | null): ColorDef | null {
  if (!color) return null
  const found = COLOR_PALETTE.find((c) => c.id === color)
  if (found) return found
  if (color.startsWith('#')) {
    return {
      id: color,
      label: color,
      accent: '',
      badge: 'border',
      cardBorder: 'border',
      cardTopBar: '',
      folderTab: 'border',
      folderBg: '',
      folderIcon: '',
      style: {
        accent: { backgroundColor: color },
        badge: {
          backgroundColor: `${color}1a`,
          color: color,
          borderColor: `${color}4d`,
        },
        cardBorder: {
          borderColor: `${color}4d`,
        },
        cardTopBar: {
          backgroundColor: color,
        },
        folderTab: {
          backgroundColor: `${color}26`,
          color: color,
          borderColor: `${color}66`,
        },
        folderBg: {
          backgroundColor: `${color}0d`,
        },
        folderIcon: {
          color: color,
        },
      },
    }
  }
  return null
}

export type VaultStorageMode = 'online' | 'local'

const STORAGE_KEY_STORAGE_MODE = 'chapters_vault_storage_mode'
const STORAGE_KEY_FOLDERS = 'chapters_vault_folders'
const STORAGE_KEY_FOLDER_COLORS = 'chapters_folder_colors'
const STORAGE_KEY_VAULT_COLORS = 'chapters_vault_colors'
const STORAGE_KEY_FAVORITES = 'chapters_vault_favorites'

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

/**
 * Hook to manage folder assignments, colors, and favorites for vaults.
 * Persists user assignments in localStorage and (optionally) on the server,
 * supporting online cloud sync across devices or local browser-only storage.
 */
export function useVaultFolders() {
  const [storageMode, setStorageModeState] = useState<VaultStorageMode>(() =>
    readStorage<VaultStorageMode>(STORAGE_KEY_STORAGE_MODE, 'online'),
  )

  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'saved' | 'error'>('idle')

  const [folders, setFolders] = useState<Record<string, string>>(() =>
    readStorage<Record<string, string>>(STORAGE_KEY_FOLDERS, {}),
  )

  const [folderColors, setFolderColors] = useState<Record<string, VaultColor>>(() =>
    readStorage<Record<string, VaultColor>>(STORAGE_KEY_FOLDER_COLORS, {}),
  )

  const [vaultColors, setVaultColors] = useState<Record<string, VaultColor>>(() =>
    readStorage<Record<string, VaultColor>>(STORAGE_KEY_VAULT_COLORS, {}),
  )

  const [favorites, setFavorites] = useState<Record<string, boolean>>(() =>
    readStorage<Record<string, boolean>>(STORAGE_KEY_FAVORITES, {}),
  )

  const foldersRef = useRef(folders)
  foldersRef.current = folders
  const folderColorsRef = useRef(folderColors)
  folderColorsRef.current = folderColors
  const vaultColorsRef = useRef(vaultColors)
  vaultColorsRef.current = vaultColors
  const favoritesRef = useRef(favorites)
  favoritesRef.current = favorites
  const storageModeRef = useRef(storageMode)
  storageModeRef.current = storageMode

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_FOLDERS, JSON.stringify(folders))
    } catch {
      // ignore
    }
  }, [folders])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_FOLDER_COLORS, JSON.stringify(folderColors))
    } catch {
      // ignore
    }
  }, [folderColors])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_VAULT_COLORS, JSON.stringify(vaultColors))
    } catch {
      // ignore
    }
  }, [vaultColors])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(favorites))
    } catch {
      // ignore
    }
  }, [favorites])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_STORAGE_MODE, JSON.stringify(storageMode))
    } catch {
      // ignore
    }
  }, [storageMode])

  // Schedule remote debounce push when online
  const triggerRemoteSync = useCallback(
    (
      newFolders: Record<string, string>,
      newFolderColors: Record<string, VaultColor>,
      newVaultColors: Record<string, VaultColor>,
      newFavorites: Record<string, boolean>,
    ) => {
      if (storageModeRef.current !== 'online') return

      setSyncStatus('syncing')
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      debounceTimerRef.current = setTimeout(async () => {
        try {
          await updateVaultUserPreferences({
            storageMode: 'online',
            folders: newFolders,
            folderColors: newFolderColors,
            vaultColors: newVaultColors,
            favorites: newFavorites,
          })
          setSyncStatus('saved')
        } catch {
          setSyncStatus('error')
        }
      }, 500)
    },
    [],
  )

  // Initial load from server if online
  useEffect(() => {
    let active = true
    if (storageMode !== 'online') return

    async function initRemote() {
      try {
        setSyncStatus('syncing')
        const remote = await getVaultUserPreferences()
        if (!active) return

        if (remote.storageMode && remote.storageMode !== storageModeRef.current) {
          setStorageModeState(remote.storageMode)
          try {
            localStorage.setItem(STORAGE_KEY_STORAGE_MODE, JSON.stringify(remote.storageMode))
          } catch {
            // ignore
          }
          if (remote.storageMode === 'local') {
            setSyncStatus('idle')
            return
          }
        }

        const remoteFolders = remote.folders || {}
        const remoteFolderColors = (remote.folderColors || {}) as Record<string, VaultColor>
        const remoteVaultColors = (remote.vaultColors || {}) as Record<string, VaultColor>
        const remoteFavorites = remote.favorites || {}

        // Merge: keep local items that remote might not have yet (e.g. created on this device while offline)
        const localFolders = foldersRef.current
        const localFolderColors = folderColorsRef.current
        const localVaultColors = vaultColorsRef.current
        const localFavorites = favoritesRef.current

        let hasNewLocalData = false
        for (const [id, f] of Object.entries(localFolders)) {
          if (f && !remoteFolders[id]) {
            hasNewLocalData = true
            break
          }
        }

        const mergedFolders = { ...localFolders, ...remoteFolders }
        const mergedFolderColors = { ...localFolderColors, ...remoteFolderColors }
        const mergedVaultColors = { ...localVaultColors, ...remoteVaultColors }
        const mergedFavorites = { ...localFavorites, ...remoteFavorites }

        setFolders(mergedFolders)
        setFolderColors(mergedFolderColors)
        setVaultColors(mergedVaultColors)
        setFavorites(mergedFavorites)

        if (hasNewLocalData) {
          await updateVaultUserPreferences({
            storageMode: 'online',
            folders: mergedFolders,
            folderColors: mergedFolderColors,
            vaultColors: mergedVaultColors,
            favorites: mergedFavorites,
          })
        }
        setSyncStatus('saved')
      } catch {
        if (!active) return
        setSyncStatus('error')
      }
    }

    initRemote()
    return () => {
      active = false
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [storageMode])

  const setVaultFolder = useCallback(
    (vaultId: string, folder: string) => {
      const trimmed = folder.trim()
      setFolders((prev) => {
        const next = { ...prev }
        if (trimmed) {
          next[vaultId] = trimmed
        } else {
          delete next[vaultId]
        }
        triggerRemoteSync(next, folderColorsRef.current, vaultColorsRef.current, favoritesRef.current)
        return next
      })
    },
    [triggerRemoteSync],
  )

  const getVaultFolder = useCallback(
    (vaultId: string, vaultName?: string): string => {
      const explicit = folders[vaultId]
      if (explicit) return explicit
      if (vaultName && vaultName.includes('/')) {
        const parts = vaultName.split('/')
        const first = parts[0]?.trim()
        if (parts.length > 1 && first) {
          return first
        }
      }
      return ''
    },
    [folders],
  )

  const setFolderColor = useCallback(
    (folderName: string, color?: VaultColor) => {
      setFolderColors((prev) => {
        const next = { ...prev }
        if (color) {
          next[folderName] = color
        } else {
          delete next[folderName]
        }
        triggerRemoteSync(foldersRef.current, next, vaultColorsRef.current, favoritesRef.current)
        return next
      })
    },
    [triggerRemoteSync],
  )

  const getFolderColor = useCallback(
    (folderName: string): VaultColor | undefined => {
      return folderColors[folderName]
    },
    [folderColors],
  )

  const setVaultColor = useCallback(
    (vaultId: string, color?: VaultColor) => {
      setVaultColors((prev) => {
        const next = { ...prev }
        if (color) {
          next[vaultId] = color
        } else {
          delete next[vaultId]
        }
        triggerRemoteSync(foldersRef.current, folderColorsRef.current, next, favoritesRef.current)
        return next
      })
    },
    [triggerRemoteSync],
  )

  const getVaultColor = useCallback(
    (vaultId: string): VaultColor | undefined => {
      return vaultColors[vaultId]
    },
    [vaultColors],
  )

  const toggleFavorite = useCallback(
    (vaultId: string) => {
      setFavorites((prev) => {
        const next = { ...prev }
        if (next[vaultId]) {
          delete next[vaultId]
        } else {
          next[vaultId] = true
        }
        triggerRemoteSync(foldersRef.current, folderColorsRef.current, vaultColorsRef.current, next)
        return next
      })
    },
    [triggerRemoteSync],
  )

  const isFavorite = useCallback(
    (vaultId: string): boolean => {
      return Boolean(favorites[vaultId])
    },
    [favorites],
  )

  const setStorageMode = useCallback(
    async (mode: VaultStorageMode) => {
      setStorageModeState(mode)
      try {
        localStorage.setItem(STORAGE_KEY_STORAGE_MODE, JSON.stringify(mode))
      } catch {
        // ignore
      }

      if (mode === 'online') {
        setSyncStatus('syncing')
        try {
          await updateVaultUserPreferences({
            storageMode: 'online',
            folders: foldersRef.current,
            folderColors: folderColorsRef.current,
            vaultColors: vaultColorsRef.current,
            favorites: favoritesRef.current,
          })
          setSyncStatus('saved')
        } catch {
          setSyncStatus('error')
        }
      } else {
        setSyncStatus('idle')
        try {
          await updateVaultUserPreferences({
            storageMode: 'local',
          })
        } catch {
          // ignore
        }
      }
    },
    [],
  )

  const syncNow = useCallback(async () => {
    if (storageModeRef.current !== 'online') return
    setSyncStatus('syncing')
    try {
      const res = await updateVaultUserPreferences({
        storageMode: 'online',
        folders: foldersRef.current,
        folderColors: folderColorsRef.current,
        vaultColors: vaultColorsRef.current,
        favorites: favoritesRef.current,
      })
      if (res.folders) setFolders(res.folders)
      if (res.folderColors) setFolderColors(res.folderColors as Record<string, VaultColor>)
      if (res.vaultColors) setVaultColors(res.vaultColors as Record<string, VaultColor>)
      if (res.favorites) setFavorites(res.favorites)
      setSyncStatus('saved')
    } catch {
      setSyncStatus('error')
    }
  }, [])

  const allFolders = Array.from(
    new Set(Object.values(folders).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b))

  return {
    folders,
    allFolders,
    setVaultFolder,
    getVaultFolder,
    folderColors,
    setFolderColor,
    getFolderColor,
    vaultColors,
    setVaultColor,
    getVaultColor,
    favorites,
    toggleFavorite,
    isFavorite,
    storageMode,
    setStorageMode,
    syncStatus,
    syncNow,
  }
}

