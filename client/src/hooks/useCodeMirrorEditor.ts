import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'

interface UseCodeMirrorEditorOptions {
  doc: string
  onChange: (doc: string) => void
  readOnly?: boolean
}

export function useCodeMirrorEditor({ doc, onChange, readOnly = false }: UseCodeMirrorEditorOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  // Keep the ref pointing at the latest onChange without re-running the
  // mount effect below. Assigned in an effect (not during render) so the
  // update is a committed side effect — the CM6 updateListener only reads
  // this ref at edit time, always after this effect has run.
  useEffect(() => {
    onChangeRef.current = onChange
  })

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
        // A genuinely non-editable rendered view needs BOTH: readOnly blocks
        // edit transactions/commands, editable=false drops contentEditable so
        // there's no caret. (CM6's documented recipe for a true read-only view.)
        ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })

    return () => {
      view.destroy()
    }
    // Mount once per component instance — `doc` and `readOnly` are captured at
    // mount. Callers that need a different `readOnly` remount this component
    // (Task 2 keys on it), matching how `doc` is already handled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return containerRef
}
