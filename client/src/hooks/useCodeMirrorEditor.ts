import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'

interface UseCodeMirrorEditorOptions {
  doc: string
  onChange: (doc: string) => void
}

export function useCodeMirrorEditor({ doc, onChange }: UseCodeMirrorEditorOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      doc,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
        EditorView.theme({
          '&': { fontFamily: 'var(--font-mono)', fontSize: '14px', height: '100%' },
          '.cm-content': { fontFamily: 'var(--font-mono)' },
          '.cm-scroller': { overflow: 'auto' },
        }),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })

    return () => {
      view.destroy()
    }
    // Mount once per component instance — `doc` is only the INITIAL
    // document. Switching notes remounts this component entirely (Task 4
    // keys the content component by note path) rather than re-syncing
    // `doc` into a live EditorView, which would fight the user's cursor
    // position on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return containerRef
}
