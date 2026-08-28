import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import * as Y from 'yjs'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { useCodeMirrorEditor } from './useCodeMirrorEditor.js'
import type { EditorCollab } from './useCodeMirrorEditor.js'
import { expectNoA11yViolations } from '../test/axe.js'

function Harness({
  doc,
  onChange,
  readOnly,
  collab,
}: {
  doc: string
  onChange: (doc: string) => void
  readOnly?: boolean
  collab?: EditorCollab
}) {
  const ref = useCodeMirrorEditor({ doc, onChange, readOnly, collab })
  return <div ref={ref} data-testid="editor-container" />
}

/** A note already loaded from the relay, so the Y.Text and the REST copy differ. */
function crdtNote(text: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('body')
  ytext.insert(0, text)
  return { ydoc, ytext }
}

function editorView(container: HTMLElement): EditorView {
  return EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
}

function text(container: HTMLElement): string {
  return container.querySelector('.cm-content')?.textContent ?? ''
}

/**
 * The shape `yCollab` reads off an awareness instance: one remote peer with a
 * selection, so the pen-nib caret has something to render. Hand-built rather
 * than a real `Awareness` — y-protocols is a transitive dependency and pnpm
 * keeps it out of this package's node_modules.
 */
function awarenessWithPeer(ytext: Y.Text, color: string) {
  const states = new Map([
    [
      2,
      {
        cursor: {
          anchor: Y.createRelativePositionFromTypeIndex(ytext, 0),
          head: Y.createRelativePositionFromTypeIndex(ytext, 4),
        },
        user: { name: 'Jane', color, colorLight: `${color}33` },
      },
    ],
  ])
  const listeners: ((change: { added: number[]; updated: number[]; removed: number[] }) => void)[] = []
  const awareness = {
    doc: { clientID: 1 },
    getLocalState: () => null,
    setLocalStateField: () => {},
    getStates: () => states,
    on: (_event: string, listener: (typeof listeners)[number]) => listeners.push(listener),
    off: () => {},
  }
  return {
    awareness: awareness as unknown as EditorCollab['awareness'],
    /** The peer moves their cursor; y-codemirror redraws off this event. */
    peerMoved: () => listeners.forEach((l) => l({ added: [], updated: [2], removed: [] })),
  }
}

describe('useCodeMirrorEditor with a collab binding', () => {
  it('seeds the editor from the Y.Text, not from the stale REST copy', () => {
    const { ytext } = crdtNote('merged text from the relay')

    const { getByTestId } = render(
      <Harness doc="stale copy fetched over REST" onChange={vi.fn()} collab={{ ytext, awareness: null }} />,
    )

    expect(text(getByTestId('editor-container'))).toBe('merged text from the relay')
  })

  it("applies another editor's insert to the document", () => {
    const { ytext } = crdtNote('the end')

    const { getByTestId } = render(
      <Harness doc="" onChange={vi.fn()} collab={{ ytext, awareness: null }} />,
    )
    ytext.insert(0, 'from a peer to ')

    expect(text(getByTestId('editor-container'))).toBe('from a peer to the end')
  })

  it('writes local typing back into the Y.Text', () => {
    const { ytext } = crdtNote('tail')

    const { getByTestId } = render(
      <Harness doc="" onChange={vi.fn()} collab={{ ytext, awareness: null }} />,
    )
    editorView(getByTestId('editor-container')).dispatch({ changes: { from: 0, insert: 'head and ' } })

    expect(ytext.toString()).toBe('head and tail')
  })

  it('reports no onChange under collab — the Y.Doc is the source of truth, not a PUT', () => {
    const { ytext } = crdtNote('body')
    const onChange = vi.fn()

    const { getByTestId } = render(
      <Harness doc="" onChange={onChange} collab={{ ytext, awareness: null }} />,
    )
    editorView(getByTestId('editor-container')).dispatch({ changes: { from: 0, insert: 'typed ' } })
    ytext.insert(0, 'remote ')

    expect(onChange).not.toHaveBeenCalled()
  })

  it('still reports onChange without collab (so the check above is not vacuous)', () => {
    const onChange = vi.fn()

    const { getByTestId } = render(<Harness doc="body" onChange={onChange} />)
    editorView(getByTestId('editor-container')).dispatch({ changes: { from: 0, insert: 'typed ' } })

    expect(onChange).toHaveBeenCalledWith('typed body')
  })

  it("leaves CodeMirror's own history out, so undo cannot revert a peer's edit", () => {
    const { ytext } = crdtNote('mine')

    const { getByTestId } = render(
      <Harness doc="" onChange={vi.fn()} collab={{ ytext, awareness: null }} />,
    )
    const view = editorView(getByTestId('editor-container'))
    ytext.insert(0, 'theirs ')

    expect(undo(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('theirs mine')
  })

  it('keeps CodeMirror history without collab (so the check above is not vacuous)', () => {
    const { getByTestId } = render(<Harness doc="mine" onChange={vi.fn()} />)
    const view = editorView(getByTestId('editor-container'))
    view.dispatch({ changes: { from: 0, insert: 'oops ' } })

    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('mine')
  })

  it('renders a remote caret in the peer ink once awareness arrives after connecting', () => {
    const { ytext } = crdtNote('shared line')
    const collab: EditorCollab = { ytext, awareness: null }

    const { getByTestId, rerender } = render(<Harness doc="" onChange={vi.fn()} collab={collab} />)
    const container = getByTestId('editor-container')
    expect(container.querySelector('.cm-ySelectionCaret')).toBeNull()

    // The provider finishes its handshake: awareness appears, the caret with it.
    const peer = awarenessWithPeer(ytext, '#3B4C8C')
    rerender(<Harness doc="" onChange={vi.fn()} collab={{ ytext, awareness: peer.awareness }} />)
    peer.peerMoved()

    const caret = container.querySelector('.cm-ySelectionCaret')
    expect(caret).not.toBeNull()
    expect(caret?.getAttribute('style')).toContain('#3B4C8C')
    expect(container.querySelector('.cm-ySelectionInfo')?.textContent).toBe('Jane')
  })

  it('installs the pen nib, so a remote caret is a nib and not the shipped round dot', () => {
    const { ytext } = crdtNote('shared line')
    const peer = awarenessWithPeer(ytext, '#3B4C8C')

    const { getByTestId } = render(
      <Harness doc="" onChange={vi.fn()} collab={{ ytext, awareness: peer.awareness }} />,
    )
    peer.peerMoved()
    const container = getByTestId('editor-container')

    // The theme reaches the *constructed state*, not just the module: this is
    // read off the caret y-codemirror.next actually rendered in this view.
    const nib = container.querySelector('.cm-ySelectionCaretDot') as HTMLElement | null
    expect(nib).not.toBeNull()
    const style = getComputedStyle(nib!)
    expect(style.clipPath).toBe('polygon(0 0, 100% 0, 50% 100%)')
    expect(style.borderRadius).toBe('0px') // y-codemirror.next's own base theme rounds it to a dot

    // The reduced-motion rule rides along with the theme; without the theme
    // installed the name tag animates for everyone.
    const css = Array.from(document.querySelectorAll('style'), (s) => s.textContent ?? '').join('\n')
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.cm-ySelectionInfo \{[^}]*animation-name: none/,
    )
  })

  it('locks in place when access is revoked, keeping the unsent text on screen', () => {
    const { ytext } = crdtNote('half a sen')
    const collab: EditorCollab = { ytext, awareness: null }

    const { getByTestId, rerender } = render(<Harness doc="" onChange={vi.fn()} collab={collab} />)
    const container = getByTestId('editor-container')
    editorView(container).dispatch({ changes: { from: ytext.length, insert: 'tence' } })
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true')

    // Kicked: useCollabDoc reports `revoked` and NoteView locks the editor.
    rerender(<Harness doc="" onChange={vi.fn()} readOnly collab={collab} />)

    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
    expect(editorView(container).state.readOnly).toBe(true)
    expect(text(container)).toBe('half a sentence')
  })

  it('unlocks again if access comes back', () => {
    const { ytext } = crdtNote('body')
    const collab: EditorCollab = { ytext, awareness: null }

    const { getByTestId, rerender } = render(
      <Harness doc="" onChange={vi.fn()} readOnly collab={collab} />,
    )
    rerender(<Harness doc="" onChange={vi.fn()} collab={collab} />)

    const container = getByTestId('editor-container')
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true')
    expect(editorView(container).state.readOnly).toBe(false)
  })

  it('has no accessibility violations', async () => {
    const { ytext } = crdtNote('shared line')

    const { container } = render(
      <Harness
        doc=""
        onChange={vi.fn()}
        collab={{ ytext, awareness: awarenessWithPeer(ytext, '#3B4C8C').awareness }}
      />,
    )

    await expectNoA11yViolations(container)
  })
})
