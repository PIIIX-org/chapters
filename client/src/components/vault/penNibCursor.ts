import { EditorView } from '@codemirror/view'

/**
 * The remote-cursor mark for collaborative editing
 * (`docs/superpowers/specs/2026-07-19-ui-design-system.md`).
 *
 * `yCollab` supplies the position and the colour — it reads `user.color` /
 * `user.colorLight` straight off awareness and writes them inline on the caret
 * — so this file supplies only the *shape*. That shape is a pen nib, not
 * Figma's arrow: a wedge that tapers down into the stroke, which is this
 * product's own mark rather than a borrowed one.
 *
 * `EditorView.theme` (not `baseTheme`) on purpose: y-codemirror.next ships its
 * own `baseTheme` for these same selectors, and only a themed rule outranks it.
 */
export const penNibCursor = EditorView.theme({
  // The stroke. The base theme rules both sides of the caret; a nib lays down
  // one line, not two.
  '.cm-ySelectionCaret': {
    borderLeftWidth: '2px',
    borderRightWidth: '0',
    marginRight: '0',
  },

  // The dot becomes the nib itself: a wedge above the stroke, tapering to a
  // point where the ink meets the text.
  '.cm-ySelectionCaretDot': {
    borderRadius: '0',
    width: '0.52em',
    height: '0.46em',
    top: '-0.46em',
    left: '-0.27em',
    clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
    transition: 'none',
  },
  // The base theme shrinks the dot away on hover, which would leave a bare
  // line. The nib stays.
  '.cm-ySelectionCaret:hover > .cm-ySelectionCaretDot': {
    transform: 'none',
  },

  // The name tag hangs *under* the nib, below the line rather than over the
  // text being read, and fades once the cursor has been still for a couple of
  // seconds. `yCollab` rebuilds the caret widget on every move, so the
  // animation restarts by itself — there is no timer to own or leak.
  '.cm-ySelectionInfo': {
    top: '1.15em',
    left: '-2px',
    borderRadius: '2px',
    fontFamily: 'inherit',
    // The tag's background is the peer's ink, and y-codemirror.next hardcodes
    // white on it. That holds on the light inks and fails on the dark ones —
    // white measures 1.9:1 – 3.1:1 on those. This is the token the design
    // system already flips for text sitting on the human accent.
    color: 'var(--primary-foreground)',
    animationName: 'cm-penNibLabel',
    animationDuration: '2.6s',
    animationTimingFunction: 'ease-in-out',
    animationFillMode: 'forwards',
  },
  // Hovering a nib is how you ask "who is this?" after the tag has gone.
  '.cm-ySelectionCaret:hover > .cm-ySelectionInfo': {
    animationName: 'none',
    opacity: 1,
  },
  '@keyframes cm-penNibLabel': {
    '0%': { opacity: 1 },
    '77%': { opacity: 1 },
    '100%': { opacity: 0 },
  },

  // Reduced motion gets no fade: the tag is simply out of the way, and hover
  // still answers who is there.
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-ySelectionInfo': {
      animationName: 'none',
      opacity: 0,
    },
  },
})
