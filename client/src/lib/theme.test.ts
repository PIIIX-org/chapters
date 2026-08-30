import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { THEME_STORAGE_KEY, applyTheme, readThemePreference, resolveTheme, themeStore } from './theme'

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
    themeStore.reset()
    document.documentElement.classList.remove('dark')
  })
  afterEach(() => {
    themeStore.reset()
  })

  it('defaults to dark when nothing is stored, and ignores junk', () => {
    expect(readThemePreference()).toBe('dark')
    localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    expect(readThemePreference()).toBe('dark')
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(readThemePreference()).toBe('light')
  })

  it('resolves system from the OS preference and everything else literally', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('applies the resolved theme as the .dark class and color-scheme', () => {
    const root = document.createElement('div')
    applyTheme('dark', root)
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
    applyTheme('light', root)
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.style.colorScheme).toBe('light')
  })

  it('store: set persists, applies to <html>, and notifies subscribers', () => {
    let notified = 0
    const unsubscribe = themeStore.subscribe(() => {
      notified += 1
    })
    themeStore.set('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(themeStore.get()).toBe('light')
    expect(notified).toBe(1)
    unsubscribe()
    themeStore.set('dark')
    expect(notified).toBe(1)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
