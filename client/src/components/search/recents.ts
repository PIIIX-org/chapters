/**
 * Recent destinations for ⌘K — the last few places a person went through
 * the palette, shown before they type. Persisted per browser in
 * localStorage; nothing here is shared or synced.
 */
export const RECENTS_STORAGE_KEY = 'chapters.recents'
export const MAX_RECENTS = 8

export type RecentKind = 'area' | 'vault' | 'repo' | 'note'
const KINDS: readonly RecentKind[] = ['area', 'vault', 'repo', 'note']

export interface Recent {
  kind: RecentKind
  label: string
  /** The route the destination lives at; recents dedupe on it. */
  path: string
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Storage access can throw (privacy modes); the palette must still open.
    return null
  }
}

function isRecent(value: unknown): value is Recent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (KINDS as readonly unknown[]).includes(v.kind) &&
    typeof v.label === 'string' &&
    v.label.length > 0 &&
    typeof v.path === 'string' &&
    v.path.length > 0
  )
}

export function readRecents(): Recent[] {
  try {
    const raw = storage()?.getItem(RECENTS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecent).slice(0, MAX_RECENTS)
  } catch {
    // Corrupt or unreadable storage is the same as no history.
    return []
  }
}

function writeRecents(recents: Recent[]): void {
  try {
    storage()?.setItem(RECENTS_STORAGE_KEY, JSON.stringify(recents))
  } catch {
    // A history that cannot persist still shows for this session.
  }
}

/** Newest first, one entry per path, capped at MAX_RECENTS. */
export function pushRecent(recents: Recent[], next: Recent): Recent[] {
  return [next, ...recents.filter((r) => r.path !== next.path)].slice(0, MAX_RECENTS)
}

// ---- store -------------------------------------------------------------
// A cached snapshot plus listeners, so `useSyncExternalStore` gets a stable
// array between writes (a fresh parse per render would loop it).

type Listener = () => void
let cache: Recent[] | null = null
const listeners = new Set<Listener>()

function current(): Recent[] {
  cache ??= readRecents()
  return cache
}

export const recentsStore = {
  get(): Recent[] {
    return current()
  },
  record(next: Recent): void {
    cache = pushRecent(current(), next)
    writeRecents(cache)
    listeners.forEach((l) => l())
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Forget everything — storage and cache. */
  clear(): void {
    cache = []
    try {
      storage()?.removeItem(RECENTS_STORAGE_KEY)
    } catch {
      // Nothing to clear if storage is unreachable.
    }
    listeners.forEach((l) => l())
  },
  /** Test hook: drop the cache so the next read hits storage. */
  reset(): void {
    cache = null
  },
}
