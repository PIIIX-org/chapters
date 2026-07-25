import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useCodeMirrorEditor } from './useCodeMirrorEditor'

function Harness({
  doc,
  onChange,
  readOnly,
  wikilinkTargets,
}: {
  doc: string
  onChange: (doc: string) => void
  readOnly?: boolean
  wikilinkTargets?: string[]
}) {
  const ref = useCodeMirrorEditor({ doc, onChange, readOnly, wikilinkTargets })
  return <div ref={ref} data-testid="editor-container" />
}

describe('useCodeMirrorEditor', () => {
  it('mounts CodeMirror with the initial document text', () => {
    const { getByTestId } = render(<Harness doc="# Hello" onChange={vi.fn()} />)

    const container = getByTestId('editor-container')
    expect(container.querySelector('.cm-editor')).not.toBeNull()
    expect(container.querySelector('.cm-content')?.textContent).toBe('# Hello')
  })

  it('does not call onChange on mount', () => {
    const onChange = vi.fn()
    render(<Harness doc="# Hello" onChange={onChange} />)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('is editable by default (contenteditable true)', () => {
    const { getByTestId } = render(<Harness doc="# Hello" onChange={vi.fn()} />)

    const content = getByTestId('editor-container').querySelector('.cm-content')
    expect(content?.getAttribute('contenteditable')).toBe('true')
  })

  it('is non-editable when readOnly is set (contenteditable false)', () => {
    const { getByTestId } = render(<Harness doc="# Hello" onChange={vi.fn()} readOnly />)

    const content = getByTestId('editor-container').querySelector('.cm-content')
    expect(content?.getAttribute('contenteditable')).toBe('false')
  })

  it('applies markdown styling classes (heading, strong, emphasis, code)', () => {
    const { getByTestId } = render(
      <Harness doc={'# Title\n\n**bold** and *italic* and `code`'} onChange={vi.fn()} />,
    )
    const container = getByTestId('editor-container')
    expect(container.querySelector('.cm-md-h1')).not.toBeNull()
    expect(container.querySelector('.cm-md-strong')).not.toBeNull()
    expect(container.querySelector('.cm-md-emphasis')).not.toBeNull()
    expect(container.querySelector('.cm-md-code')).not.toBeNull()
  })

  it('shows the heading marker when the cursor is on that line', () => {
    render(<Harness doc={'# Heading\n\nbody'} onChange={vi.fn()} />)
    // Default selection is at offset 0 → line 1 is active → marker visible.
    const firstLine = document.querySelector('.cm-line')
    expect(firstLine?.textContent).toBe('# Heading')
  })

  it('hides the heading marker when the cursor is on another line', async () => {
    render(<Harness doc={'# Heading\n\nbody'} onChange={vi.fn()} />)
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
    // Move the cursor to the end (the "body" line) — line 1 is no longer active.
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    const firstLine = document.querySelector('.cm-line')
    expect(firstLine?.textContent).toBe('Heading')
  })

  it('hides inline emphasis/code markers on an inactive line', async () => {
    render(<Harness doc={'top\n\n**bold** and `code`'} onChange={vi.fn()} />)
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
    // Cursor on line 1 ("top"); the emphasis/code line is inactive.
    view.dispatch({ selection: { anchor: 0 } })
    const lines = document.querySelectorAll('.cm-line')
    const last = lines[lines.length - 1]
    expect(last?.textContent).toBe('bold and code')
  })

  it('reveals a hidden heading marker when the cursor moves back onto its line', async () => {
    render(<Harness doc={'# Heading\n\nbody'} onChange={vi.fn()} />)
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!

    // Off the heading line → hidden.
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    expect(document.querySelector('.cm-line')?.textContent).toBe('Heading')

    // Back onto the heading line → revealed.
    view.dispatch({ selection: { anchor: 0 } })
    expect(document.querySelector('.cm-line')?.textContent).toBe('# Heading')
  })

  it('keeps fenced-code fences visible (does not blank the ``` lines)', async () => {
    render(<Harness doc={'intro\n\n```\ncode\n```'} onChange={vi.fn()} />)
    const { EditorView } = await import('@codemirror/view')
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
    // Cursor on line 1; the fenced block is inactive — fences must NOT be hidden.
    view.dispatch({ selection: { anchor: 0 } })
    const text = document.querySelector('.cm-content')?.textContent ?? ''
    expect(text).toContain('```')
    expect(text).toContain('code')
  })

  it('mounts with wikilinkTargets set (autocomplete wired, editor intact)', () => {
    const { getByTestId } = render(
      <Harness doc={'body'} onChange={vi.fn()} wikilinkTargets={['people/jane']} />,
    )
    const container = getByTestId('editor-container')
    expect(container.querySelector('.cm-content')?.textContent).toBe('body')
  })
})
