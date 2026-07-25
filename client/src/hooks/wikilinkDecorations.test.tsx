import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { wikilinkExtension } from './wikilinkDecorations'

// Minimal harness: mount a plain EditorView with just the wikilink extension.
function Editor({ doc, onClick }: { doc: string; onClick: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [wikilinkExtension(onClick)] }),
      parent: ref.current!,
    })
    return () => view.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={ref} data-testid="ed" />
}

describe('wikilinkExtension', () => {
  it('decorates a [[path]] with the wikilink class + target attribute', () => {
    const { getByTestId } = render(<Editor doc="see [[people/jane]] here" onClick={vi.fn()} />)
    const link = getByTestId('ed').querySelector('.cm-wikilink')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('data-wikilink-target')).toBe('people/jane')
  })

  it('navigates (calls onClick) when a wikilink on a non-cursor line is clicked', () => {
    const onClick = vi.fn()
    // cursor defaults to offset 0 (line 1); the wikilink is on line 3.
    const { getByTestId } = render(<Editor doc={'line one\n\n[[people/jane]]'} onClick={onClick} />)
    const link = getByTestId('ed').querySelector('.cm-wikilink') as HTMLElement
    fireEvent.mouseDown(link, { button: 0 })
    expect(onClick).toHaveBeenCalledWith('people/jane')
  })

  it('does NOT navigate when the wikilink is on the cursor line (edit mode)', () => {
    const onClick = vi.fn()
    // cursor at 0 = line 1, where the wikilink also is → editing, not navigating.
    const { getByTestId } = render(<Editor doc={'[[people/jane]] rest'} onClick={onClick} />)
    const link = getByTestId('ed').querySelector('.cm-wikilink') as HTMLElement
    fireEvent.mouseDown(link, { button: 0 })
    expect(onClick).not.toHaveBeenCalled()
  })
})
