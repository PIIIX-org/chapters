import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useCodeMirrorEditor } from './useCodeMirrorEditor'

function Harness({
  doc,
  onChange,
  readOnly,
}: {
  doc: string
  onChange: (doc: string) => void
  readOnly?: boolean
}) {
  const ref = useCodeMirrorEditor({ doc, onChange, readOnly })
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
})
