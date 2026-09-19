import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { NoteRichToolbar } from './NoteRichToolbar.js'
import { applyFormat } from './note-toolbar-utils.js'

describe('NoteRichToolbar', () => {
  it('renders all formatting buttons and width adjustment controls', () => {
    const onWidthChange = vi.fn()
    render(
      <NoteRichToolbar
        view={null}
        readOnly={false}
        width="standard"
        onWidthChange={onWidthChange}
      />,
    )

    // Basic formatting tools
    expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Italic' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Strikethrough' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inline Code' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Highlight' })).toBeInTheDocument()

    // Headings
    expect(screen.getByRole('button', { name: 'Heading 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Heading 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Heading 3' })).toBeInTheDocument()

    // Lists & Blocks
    expect(screen.getByRole('button', { name: 'Bullet List' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Numbered List' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Task Checklist' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Table' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Quote' })).toBeInTheDocument()

    // Width adjustment buttons
    expect(screen.getByRole('button', { name: /compact note width/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /standard note width/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /wide note width/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /full width/i })).toBeInTheDocument()

    // Clicking a width button calls onWidthChange
    fireEvent.click(screen.getByRole('button', { name: /wide note width/i }))
    expect(onWidthChange).toHaveBeenCalledWith('wide')
  })

  it('disables formatting buttons when readOnly is true', () => {
    render(
      <NoteRichToolbar
        view={null}
        readOnly={true}
        width="standard"
        onWidthChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Italic' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Heading 1' })).toBeDisabled()
  })

  it('applies bold formatting to editor selection', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const state = EditorState.create({
      doc: 'hello world',
      selection: { anchor: 0, head: 5 }, // selects "hello"
    })
    const view = new EditorView({ state, parent })

    applyFormat(view, 'bold')

    expect(view.state.doc.toString()).toBe('**hello** world')
    view.destroy()
    parent.remove()
  })

  it('applies heading 1 formatting to current line', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const state = EditorState.create({
      doc: 'First title',
      selection: { anchor: 2 },
    })
    const view = new EditorView({ state, parent })

    applyFormat(view, 'h1')

    expect(view.state.doc.toString()).toBe('# First title')
    view.destroy()
    parent.remove()
  })
})
