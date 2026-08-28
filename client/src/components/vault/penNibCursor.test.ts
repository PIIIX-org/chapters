import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import { AI_INK, inkFor } from '../../lib/ink.js'
import type { Ink } from '../../lib/ink.js'
import { penNibCursor } from './penNibCursor.js'

/**
 * The five things `YRemoteSelectionsPluginValue` actually asks of an awareness
 * instance. `y-protocols` is not a client dependency — it arrives transitively
 * under `@hocuspocus/provider` — so the shape is stubbed here and the *real*
 * `yCollab` renders against it. Nothing about the caret DOM is hand-built.
 */
function fakeAwareness(doc: Y.Doc) {
  type Listener = (change: unknown, origin: unknown, tr: unknown) => void
  const states = new Map<number, Record<string, unknown>>()
  const listeners = new Set<Listener>()
  return {
    doc,
    states,
    getStates: () => states,
    getLocalState: () => null,
    setLocalStateField: () => {},
    on: (_event: string, fn: Listener) => listeners.add(fn),
    off: (_event: string, fn: Listener) => listeners.delete(fn),
    /** What the real `Awareness` emits when a peer's state lands. */
    emit: () => {
      for (const fn of listeners) fn({ added: [...states.keys()], updated: [], removed: [] }, null, null)
    },
  }
}

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  document.body.replaceChildren()
})

/** Mounts a real editor with `yCollab` + the nib theme, then places one remote
 *  peer's cursor through awareness — the only route by which a caret exists. */
function mountWithPeer(peer: { name: string; ink: Ink }, at = 4) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('body')
  ytext.insert(0, 'the quick brown fox jumps')
  const awareness = fakeAwareness(ydoc)

  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [yCollab(ytext, awareness as never), penNibCursor],
    }),
    parent,
  })
  views.push(view)

  const pos = Y.createRelativePositionFromTypeIndex(ytext, at)
  awareness.states.set(ydoc.clientID + 1, {
    user: { name: peer.name, color: peer.ink.color, colorLight: peer.ink.colorLight },
    cursor: { anchor: pos, head: pos },
  })
  awareness.emit()

  const caret = view.dom.querySelector('.cm-ySelectionCaret') as HTMLElement | null
  if (caret === null) throw new Error('no remote caret rendered from awareness')
  return {
    caret,
    nib: caret.querySelector('.cm-ySelectionCaretDot') as HTMLElement,
    label: caret.querySelector('.cm-ySelectionInfo') as HTMLElement,
  }
}

/** Every rule the theme injects, as CSS text — the only way to see a `:hover`
 *  or `@media` rule in happy-dom, which resolves neither. */
function injectedCss(): string {
  return Array.from(document.querySelectorAll('style'), (s) => s.textContent ?? '').join('\n')
}

// Two humans whose ids hash to *different* inks, plus the AI. A fixture where
// everyone shared a colour could not tell "reads awareness" from "hardcoded".
const JANE = { name: 'jane', ink: inkFor('b7') }
const TAHA = { name: 'taha', ink: inkFor('9') }
const AI = { name: 'Chapters MCP', ink: AI_INK }

describe('penNibCursor', () => {
  it('wears the ink each peer broadcast, and names no colour of its own', () => {
    expect(JANE.ink.color).not.toBe(TAHA.ink.color) // fixture guard

    // The style attribute, not `style.backgroundColor`: an ink is a `var()` so
    // that *this* reader's theme resolves a peer's hue rather than the theme
    // the peer happened to be in — and happy-dom drops `var()` when it parses
    // a colour property, while keeping the attribute y-codemirror.next sets.
    expect(mountWithPeer(JANE).caret.getAttribute('style')).toContain(JANE.ink.color)
    expect(mountWithPeer(TAHA).caret.getAttribute('style')).toContain(TAHA.ink.color)
    expect(mountWithPeer(AI).caret.getAttribute('style')).toContain(AI_INK.color)

    // The nib inherits rather than declaring: a literal colour here would make
    // every collaborator the same person, which is the one thing ink is for.
    expect(getComputedStyle(mountWithPeer(JANE).nib).backgroundColor).toBe('inherit')
  })

  it('draws one stroke, not a two-sided box', () => {
    const style = getComputedStyle(mountWithPeer(JANE).caret)
    expect(style.borderLeftWidth).toBe('2px')
    expect(style.borderRightWidth).toBe('0px')
  })

  it('tapers the dot into a nib sitting above the stroke', () => {
    const style = getComputedStyle(mountWithPeer(JANE).nib)
    // A round dot is what y-codemirror.next ships; a nib is a clipped wedge.
    expect(style.borderRadius).toBe('0px')
    expect(style.clipPath).toBe('polygon(0 0, 100% 0, 50% 100%)')
    expect(parseFloat(style.top)).toBeLessThan(0)
  })

  it('keeps the nib on screen when its caret is hovered', () => {
    // y-codemirror.next's own base theme scales the dot to 0 on hover, which
    // would leave a bare line exactly when someone is looking at it.
    mountWithPeer(JANE)
    expect(injectedCss()).toMatch(/\.cm-ySelectionCaret:hover > \.cm-ySelectionCaretDot \{[^}]*transform: none/)
  })

  it('hangs the peer name under the nib, clear of the text above it', () => {
    const { label } = mountWithPeer(JANE)
    expect(label.textContent).toBe('jane')
    expect(parseFloat(getComputedStyle(label).top)).toBeGreaterThan(0)
  })

  it('writes the name in a colour the ink under it can carry', () => {
    // The tag sits *on* the peer's ink, and y-codemirror.next's own white is
    // unreadable on the dark-mode inks. The contrast itself is measured in
    // lib/ink.test.ts; what this guards is that the base theme lost the fight.
    mountWithPeer(JANE)
    const declared = [...injectedCss().matchAll(/\.cm-ySelectionInfo \{[^}]*?color: ([^;]+);/g)].map((m) => m[1])
    expect(declared).toContain('white') // the base theme still asks for it...
    expect(declared.at(-1)).toBe('var(--primary-foreground)') // ...and is overruled
  })

  it('fades the name tag once the cursor has been still a couple of seconds', () => {
    const style = getComputedStyle(mountWithPeer(JANE).label)
    expect(style.animationName).toBe('cm-penNibLabel')
    expect(parseFloat(style.animationDuration)).toBeGreaterThan(2)
    expect(style.animationFillMode).toBe('forwards')
    expect(injectedCss()).toContain('@keyframes cm-penNibLabel')
  })

  it('does not animate the tag for readers who asked for reduced motion', () => {
    mountWithPeer(JANE)
    expect(injectedCss()).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.cm-ySelectionInfo \{[^}]*animation-name: none/,
    )
  })
})
