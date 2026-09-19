import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'chapters_vault_folders'

/**
 * Hook to manage folder assignments for vaults.
 * Persists user assignments in localStorage and supports parsing
 * folder names from `folder/vault-name` patterns.
 */
export function useVaultFolders() {
  const [folders, setFolders] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })

  // Sync to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(folders))
    } catch {
      // Ignore storage errors (e.g. private mode)
    }
  }, [folders])

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

  const allFolders = Array.from(
    new Set(Object.values(folders).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b))

  return {
    folders,
    allFolders,
    setVaultFolder,
    getVaultFolder,
  }
}
