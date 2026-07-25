import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

interface UseCodeMirrorEditorOptions {
  doc: string
  onChange: (doc: string) => void
  readOnly?: boolean
}

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-md-h1' },
  { tag: tags.heading2, class: 'cm-md-h2' },
  { tag: tags.heading3, class: 'cm-md-h3' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], class: 'cm-md-h4' },
  { tag: tags.strong, class: 'cm-md-strong' },
  { tag: tags.emphasis, class: 'cm-md-emphasis' },
  { tag: tags.strikethrough, class: 'cm-md-strike' },
  { tag: tags.monospace, class: 'cm-md-code' },
  { tag: [tags.link, tags.url], class: 'cm-md-link' },
  { tag: tags.quote, class: 'cm-md-quote' },
])

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
        syntaxHighlighting(markdownHighlight),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
        EditorView.theme({
          '&': { fontFamily: 'var(--font-mono)', fontSize: '14px', height: '100%' },
          '.cm-content': { fontFamily: 'var(--font-mono)' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-md-h1': { fontSize: '1.6em', fontWeight: '700', lineHeight: '1.3' },
          '.cm-md-h2': { fontSize: '1.35em', fontWeight: '700', lineHeight: '1.3' },
          '.cm-md-h3': { fontSize: '1.15em', fontWeight: '700' },
          '.cm-md-h4': { fontWeight: '700' },
          '.cm-md-strong': { fontWeight: '700' },
          '.cm-md-emphasis': { fontStyle: 'italic' },
          '.cm-md-strike': { textDecoration: 'line-through' },
          '.cm-md-code': { fontFamily: 'var(--font-mono)', fontSize: '0.9em' },
          '.cm-md-link': { color: 'var(--primary)', textDecoration: 'underline' },
          '.cm-md-quote': { fontStyle: 'italic', color: 'var(--muted-foreground)' },
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
