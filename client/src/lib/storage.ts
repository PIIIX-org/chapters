/**
 * Dual-read transparent fallback helper for localStorage migration.
 *
 * Reads canonicalKey first; if present, returns it.
 * If missing, reads legacyKey; if present, copies it forward to canonicalKey and returns it.
 * Otherwise returns null.
 */
export function getMigratedStorageItem(canonicalKey: string, legacyKey: string): string | null {
  try {
    const canonical = localStorage.getItem(canonicalKey)
    if (canonical !== null) return canonical

    const legacy = localStorage.getItem(legacyKey)
    if (legacy !== null) {
      localStorage.setItem(canonicalKey, legacy)
      return legacy
    }
  } catch {
    // In restricted iframe or private mode, localStorage may throw SecurityError
  }

  return null
}
