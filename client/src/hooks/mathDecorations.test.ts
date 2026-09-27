import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { findMathExpressions, mathLivePreview } from './mathDecorations.js'

describe('mathDecorations — parser & regex', () => {
  it('detects inline math expressions', () => {
    const doc = 'The famous equation $E = mc^2$ revolutionized physics.'
    const items = findMathExpressions(doc)

    expect(items).toHaveLength(1)
    expect(items[0]!.expr).toBe('E = mc^2')
    expect(items[0]!.displayMode).toBe(false)
    expect(items[0]!.from).toBe(20)
    expect(items[0]!.to).toBe(30)
  })

  it('detects display/block math expressions', () => {
    const doc = 'Euler identity:\n$$\ne^{i\\pi} + 1 = 0\n$$\nEnd.'
    const items = findMathExpressions(doc)

    expect(items).toHaveLength(1)
    expect(items[0]!.expr).toBe('e^{i\\pi} + 1 = 0')
    expect(items[0]!.displayMode).toBe(true)
  })

  it('handles multiple inline and block math expressions without interference', () => {
    const doc = 'First $a + b = c$, then:\n$$\nx^2 + y^2 = z^2\n$$\nAnd finally $\\alpha = 1$.'
    const items = findMathExpressions(doc)

    expect(items).toHaveLength(3)
    expect(items[0]!.expr).toBe('a + b = c')
    expect(items[0]!.displayMode).toBe(false)
    expect(items[1]!.expr).toBe('x^2 + y^2 = z^2')
    expect(items[1]!.displayMode).toBe(true)
    expect(items[2]!.expr).toBe('\\alpha = 1')
    expect(items[2]!.displayMode).toBe(false)
  })
})

describe('mathLivePreview CodeMirror extension', () => {
  it('replaces math with KaTeX widget when cursor is not touching it', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const view = new EditorView({
      state: EditorState.create({
        doc: 'Test $x + y = z$ end',
        extensions: [mathLivePreview],
        selection: { anchor: 0 },
      }),
      parent: container,
    })

    const widget = container.querySelector('.cm-math-inline')
    expect(widget).not.toBeNull()
    expect(widget!.innerHTML).toContain('katex')

    view.destroy()
    container.remove()
  })

  it('reveals raw text for editing when cursor moves into math expression', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const view = new EditorView({
      state: EditorState.create({
        doc: 'Test $x + y = z$ end',
        extensions: [mathLivePreview],
        selection: { anchor: 0 },
      }),
      parent: container,
    })

    // Initially replaced by widget
    expect(container.querySelector('.cm-math-inline')).not.toBeNull()

    // Move cursor inside $x + y = z$ (pos 8)
    view.dispatch({ selection: { anchor: 8 } })

    // Widget is removed, revealing raw text
    expect(container.querySelector('.cm-math-inline')).toBeNull()

    view.destroy()
    container.remove()
  })
})
