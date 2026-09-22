import { describe, expect, it, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  detectTextDirection,
  useNoteDirection,
  getNoteDirectionKey,
} from './note-toolbar-utils.js'

describe('detectTextDirection', () => {
  it('detects Persian/Arabic script as rtl', () => {
    expect(detectTextDirection('شات‌لیست جامع و دستورالعمل فیلم‌برداری')).toBe('rtl')
    expect(detectTextDirection('# ۱.۱ فلسفهٔ بصری صحنه (The Visual Philosophy)')).toBe('rtl')
    expect(detectTextDirection('مرحبا بالعالم')).toBe('rtl')
  })

  it('detects English/Latin script as ltr', () => {
    expect(detectTextDirection('# Hello World\nThis is a standard note.')).toBe('ltr')
    expect(detectTextDirection('const x = 42;')).toBe('ltr')
  })

  it('handles null, undefined, or empty string gracefully', () => {
    expect(detectTextDirection('')).toBe('ltr')
    expect(detectTextDirection(null)).toBe('ltr')
    expect(detectTextDirection(undefined)).toBe('ltr')
  })
})

describe('useNoteDirection', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('auto-detects rtl for Persian notes when no preference is stored', () => {
    const { result } = renderHook(() =>
      useNoteDirection('vault-1', 'note-1', 'شات‌لیست جامع'),
    )
    expect(result.current[0]).toBe('rtl')
  })

  it('auto-detects ltr for English notes when no preference is stored', () => {
    const { result } = renderHook(() =>
      useNoteDirection('vault-1', 'note-2', 'English content here'),
    )
    expect(result.current[0]).toBe('ltr')
  })

  it('allows updating direction and stores preference in localStorage', () => {
    const { result } = renderHook(() =>
      useNoteDirection('vault-1', 'note-3', 'English content'),
    )
    expect(result.current[0]).toBe('ltr')

    act(() => {
      result.current[1]('rtl')
    })

    expect(result.current[0]).toBe('rtl')
    expect(
      localStorage.getItem(getNoteDirectionKey('vault-1', 'note-3')),
    ).toBe('rtl')
  })
})
