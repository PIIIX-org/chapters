import { useSyncExternalStore } from 'react'
import {
  themeStore,
  type ResolvedTheme,
  type ThemePreference,
} from '../lib/theme.js'

export interface ThemeControls {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (next: ThemePreference) => void
}

export function useTheme(): ThemeControls {
  const preference = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.get,
    themeStore.get,
  )
  return {
    preference,
    resolved: themeStore.resolved(),
    setPreference: themeStore.set,
  }
}
