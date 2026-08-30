/**
 * Theme preference — dark is the product's face, light is a real secondary
 * theme, `system` follows the OS. Applied as the `.dark` class on <html>, which
 * is what every existing reader (`ColorModeToggle`, `GraphCanvas`,
 * `useCodeViewer`) and Tailwind's `dark:` variant already key on.
 */
export type ThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

export const THEME_STORAGE_KEY = 'chapters.theme'
export const THEME_PREFERENCES: readonly ThemePreference[] = [
  'dark',
  'light',
  'system',
]

export function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === 'string' &&
    (THEME_PREFERENCES as readonly string[]).includes(value)
  )
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Storage access can throw (privacy modes); the app must still render.
    return null
  }
}

export function readThemePreference(): ThemePreference {
  const raw = storage()?.getItem(THEME_STORAGE_KEY)
  return isThemePreference(raw) ? raw : 'dark'
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    storage()?.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Same as above: a preference that cannot persist still applies for this session.
  }
}

export function systemPrefersDark(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-color-scheme: dark)').matches
  )
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark = systemPrefersDark(),
): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

export function applyTheme(
  resolved: ResolvedTheme,
  root: HTMLElement | null = globalThis.document?.documentElement ?? null,
): void {
  if (!root) return
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
}

// ---- store -------------------------------------------------------------

type Listener = () => void
let preference: ThemePreference | null = null
const listeners = new Set<Listener>()
let mediaBound = false

function current(): ThemePreference {
  preference ??= readThemePreference()
  return preference
}

function bindMedia(): void {
  if (mediaBound || typeof matchMedia !== 'function') return
  mediaBound = true
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (current() === 'system') {
      applyTheme(resolveTheme('system'))
      listeners.forEach((l) => l())
    }
  })
}

export const themeStore = {
  get(): ThemePreference {
    return current()
  },
  resolved(): ResolvedTheme {
    return resolveTheme(current())
  },
  set(next: ThemePreference): void {
    preference = next
    writeThemePreference(next)
    applyTheme(resolveTheme(next))
    listeners.forEach((l) => l())
  },
  subscribe(listener: Listener): () => void {
    bindMedia()
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Apply the stored preference to <html>; call once before first render. */
  boot(): void {
    applyTheme(resolveTheme(current()))
  },
  /** Test hook: forget the cached preference so the next read hits storage. */
  reset(): void {
    preference = null
  },
}
