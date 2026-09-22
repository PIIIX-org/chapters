import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection } from '@codemirror/view'
import { terminalCursor } from './terminalCursor.js'

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

function mountEditor(doc = 'hello terminal cursor') {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [drawSelection(), terminalCursor],
    }),
    parent,
  })
  views.push(view)
  return view
}

function injectedCss(): string {
  return Array.from(document.querySelectorAll('style'), (s) => s.textContent ?? '').join('\n')
}

describe('terminalCursor', () => {
  it('injects terminal cursor styling with thick 8px width and no border', () => {
    mountEditor()
    const css = injectedCss()
    expect(css).toContain('.cm-cursor')
    expect(css).toContain('width: 8px !important')
    expect(css).toContain('border: none !important')
  })

  it('declares multi-color cycling animation keyframes across terminal neon hues', () => {
    mountEditor()
    const css = injectedCss()
    expect(css).toContain('@keyframes cm-terminal-cursor-blink-color')
    expect(css).toContain('#10b981') // Terminal Emerald
    expect(css).toContain('#06b6d4') // Electric Cyan
    expect(css).toContain('#f59e0b') // Vivid Amber
    expect(css).toContain('#a855f7') // Neon Purple
    expect(css).toContain('#f43f5e') // Coral Rose
  })

  it('sets native fallback caret color to emerald on .cm-content', () => {
    mountEditor()
    const css = injectedCss()
    expect(css).toMatch(/\.cm-content\s*\{[^}]*caret-color:\s*#10b981/)
  })

  it('handles both LTR and RTL cursor margins', () => {
    mountEditor()
    const css = injectedCss()
    expect(css).toContain('margin-left: 0 !important')
    expect(css).toContain('margin-left: -8px !important')
  })

  it('disables animation when prefers-reduced-motion is active', () => {
    mountEditor()
    const css = injectedCss()
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none/)
  })
})
