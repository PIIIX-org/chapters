import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { findMermaidBlocks, mermaidLivePreview } from './mermaidDecorations.js'

describe('mermaidDecorations — parser & regex', () => {
  it('detects mermaid code blocks', () => {
    const doc = 'Intro\n```mermaid\ngraph TD\n  A --> B\n```\nOutro'
    const blocks = findMermaidBlocks(doc)

    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.code.trim()).toBe('graph TD\n  A --> B')
    expect(blocks[0]!.from).toBe(6)
    expect(blocks[0]!.to).toBe(39)
  })

  it('ignores non-mermaid code blocks', () => {
    const doc = '```typescript\nconst x = 1\n```\n\n```python\nprint("hello")\n```'
    const blocks = findMermaidBlocks(doc)

    expect(blocks).toHaveLength(0)
  })

  it('detects multiple mermaid blocks', () => {
    const doc =
      '# Diagram 1\n```mermaid\nflowchart LR\n  A --> B\n```\n# Diagram 2\n```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n```'
    const blocks = findMermaidBlocks(doc)

    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.code).toContain('flowchart LR')
    expect(blocks[1]!.code).toContain('sequenceDiagram')
  })
})

describe('mermaidLivePreview CodeMirror extension', () => {
  it('replaces mermaid block with diagram container when cursor is elsewhere', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const doc = 'Intro\n```mermaid\ngraph TD\n  A --> B\n```\nOutro'
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [mermaidLivePreview],
        selection: { anchor: 0 },
      }),
      parent: container,
    })

    const widget = container.querySelector('.cm-mermaid-container')
    expect(widget).not.toBeNull()
    expect(widget!.textContent).toContain('Mermaid Diagram')

    view.destroy()
    container.remove()
  })

  it('reveals raw mermaid block when cursor moves inside the block', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const doc = 'Intro\n```mermaid\ngraph TD\n  A --> B\n```\nOutro'
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [mermaidLivePreview],
        selection: { anchor: 0 },
      }),
      parent: container,
    })

    // Initially replaced by widget
    expect(container.querySelector('.cm-mermaid-container')).not.toBeNull()

    // Move cursor inside block (pos 15 is inside ```mermaid)
    view.dispatch({ selection: { anchor: 15 } })

    // Widget is removed, revealing raw text
    expect(container.querySelector('.cm-mermaid-container')).toBeNull()

    view.destroy()
    container.remove()
  })

  it('DOMPurify strips malicious scripts and event handlers from svg output', async () => {
    const DOMPurify = (await import('dompurify')).default
    const dirtySvg = '<svg><script>alert(1)</script><circle cx="10" cy="10" r="5" onload="alert(2)"/></svg>'
    const cleanSvg = DOMPurify.sanitize(dirtySvg, { USE_PROFILES: { svg: true, svgFilters: true } })

    expect(cleanSvg).not.toContain('<script>')
    expect(cleanSvg).not.toContain('alert(1)')
    expect(cleanSvg).not.toContain('onload')
  })
})
