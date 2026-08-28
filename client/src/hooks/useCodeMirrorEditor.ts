import { useEffect, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { autocompletion } from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { penNibCursor } from '../components/vault/penNibCursor.js'
import { markdownMarkerHiding } from './markdownMarkerHiding.js'
import { wikilinkCompletions } from './wikilinkCompletions.js'
import { wikilinkExtension } from './wikilinkDecorations.js'

/** The live document, for editors only. Readers never join it — they get the
 *  SSE stream (`useLiveNote`) — so this is absent on their path. */
export interface EditorCollab {
  /** `ydoc.getText('body')`: the shape the relay loads and stores. */
  ytext: Y.Text
  /** From `useCollabDoc`. Null until the provider connects; the binding picks
   *  it up when it arrives, without rebuilding the editor. */
  awareness: HocuspocusProvider['awareness']
}

interface UseCodeMirrorEditorOptions {
  doc: string
  onChange: (doc: string) => void
  readOnly?: boolean
  wikilinkTargets?: string[]
  onWikilinkClick?: (target: string) => void
  collab?: EditorCollab
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

// A genuinely non-editable view needs BOTH: readOnly blocks edit transactions
// and commands, editable=false drops contentEditable so there's no caret.
// (CM6's documented recipe for a true read-only view.)
function lockExtensions(readOnly: boolean): Extension {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
}

export function useCodeMirrorEditor({
  doc,
  onChange,
  readOnly = false,
  wikilinkTargets = [],
  onWikilinkClick,
  collab,
}: UseCodeMirrorEditorOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  // Keep the ref pointing at the latest onChange without re-running the
  // mount effect below. Assigned in an effect (not during render) so the
  // update is a committed side effect — the CM6 updateListener only reads
  // this ref at edit time, always after this effect has run.
  useEffect(() => {
    onChangeRef.current = onChange
  })
  const onWikilinkClickRef = useRef(onWikilinkClick)
  useEffect(() => {
    onWikilinkClickRef.current = onWikilinkClick
  })

  // Two things change after mount and must not cost a rebuild: the collab
  // binding (awareness arrives once the provider connects) and the lock (a
  // revoked share freezes the editor around text the user hasn't sent yet).
  const [collabCompartment] = useState(() => new Compartment())
  const [lockCompartment] = useState(() => new Compartment())

  const ytext = collab?.ytext
  const awareness = collab?.awareness ?? null

  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      // Under collab the Y.Text *is* the document: `doc` is a REST copy fetched
      // before the CRDT loaded, and seeding from it would double the content.
      doc: ytext ? ytext.toString() : doc,
      extensions: [
        // CM6's own history undoes other people's edits in a shared document —
        // a genuine bug, not a nicety. yCollab's Yjs UndoManager undoes only
        // what this user typed, so collab swaps one for the other.
        ...(ytext ? [] : [history()]),
        keymap.of([...defaultKeymap, ...(ytext ? yUndoManagerKeymap : historyKeymap)]),
        // The nib sits outside the compartment on purpose: the compartment is
        // reconfigured to a bare `yCollab(...)` when awareness arrives, and
        // anything inside it goes with the old value.
        ...(ytext ? [collabCompartment.of(yCollab(ytext, awareness)), penNibCursor] : []),
        markdown(),
        // CM6 marks `.cm-content` role="textbox"; an ARIA input field with no
        // accessible name fails axe, and a screen reader announces nothing.
        EditorView.contentAttributes.of({ 'aria-label': 'Note body' }),
        syntaxHighlighting(markdownHighlight),
        markdownMarkerHiding,
        autocompletion({ override: [wikilinkCompletions(wikilinkTargets)] }),
        wikilinkExtension((target) => onWikilinkClickRef.current?.(target)),
        EditorView.updateListener.of((update) => {
          // Collab reports nothing: the Y.Doc is the source of truth and the
          // relay persists it. Feeding remote edits back to NoteView's
          // debounced PUT is issue #66 aimed at the engine that fixes it.
          if (update.docChanged && !ytext) onChangeRef.current(update.state.doc.toString())
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
          '.cm-wikilink': { color: 'var(--primary)', textDecoration: 'underline', cursor: 'pointer' },
        }),
        lockCompartment.of(lockExtensions(readOnly)),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    return () => {
      viewRef.current = null
      view.destroy()
    }
    // Mount once per document — `doc`, `readOnly` and the wikilink options are
    // captured at mount, as before; `awareness` is applied by the effect below
    // rather than here, so connecting doesn't rebuild the view under the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext])

  useEffect(() => {
    if (!ytext) return
    viewRef.current?.dispatch({ effects: collabCompartment.reconfigure(yCollab(ytext, awareness)) })
  }, [collabCompartment, ytext, awareness])

  // Locking is a reconfiguration, never a remount: when access is revoked
  // mid-sentence the text on screen is the user's unsent work, and rebuilding
  // the editor around it is how that work gets lost.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: lockCompartment.reconfigure(lockExtensions(readOnly)) })
  }, [lockCompartment, readOnly])

  return containerRef
}
