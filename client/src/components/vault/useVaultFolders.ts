import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

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
 * Persists user assignments in localStorage and supports parsing
 * folder names from `folder/vault-name` patterns.
 */
export function useVaultFolders() {
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

  const setVaultFolder = useCallback((vaultId: string, folder: string) => {
    const trimmed = folder.trim()
    setFolders((prev) => {
      const next = { ...prev }
      if (trimmed) {
        next[vaultId] = trimmed
      } else {
        delete next[vaultId]
      }
      return next
    })
  }, [])

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

  const setFolderColor = useCallback((folderName: string, color?: VaultColor) => {
    setFolderColors((prev) => {
      const next = { ...prev }
      if (color) {
        next[folderName] = color
      } else {
        delete next[folderName]
      }
      return next
    })
  }, [])

  const getFolderColor = useCallback(
    (folderName: string): VaultColor | undefined => {
      return folderColors[folderName]
    },
    [folderColors],
  )

  const setVaultColor = useCallback((vaultId: string, color?: VaultColor) => {
    setVaultColors((prev) => {
      const next = { ...prev }
      if (color) {
        next[vaultId] = color
      } else {
        delete next[vaultId]
      }
      return next
    })
  }, [])

  const getVaultColor = useCallback(
    (vaultId: string): VaultColor | undefined => {
      return vaultColors[vaultId]
    },
    [vaultColors],
  )

  const toggleFavorite = useCallback((vaultId: string) => {
    setFavorites((prev) => {
      const next = { ...prev }
      if (next[vaultId]) {
        delete next[vaultId]
      } else {
        next[vaultId] = true
      }
      return next
    })
  }, [])

  const isFavorite = useCallback(
    (vaultId: string): boolean => {
      return Boolean(favorites[vaultId])
    },
    [favorites],
  )

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
  }
}

