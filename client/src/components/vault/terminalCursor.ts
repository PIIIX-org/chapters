import { EditorView } from '@codemirror/view'

/**
 * Terminal-style thick block cursor with multi-color cycling blink animation.
 *
 * 1. High contrast in both dark and light modes.
 * 2. Thick terminal block appearance (width: 8px / ~0.55em, character-matching width).
 * 3. Color shifts across 5 terminal neon colors on each blink cycle
 *    (Emerald, Cyan, Amber, Neon Purple, Coral Rose).
 * 4. Proper insertion alignment in both LTR (0px) and RTL (-8px).
 * 5. Respects prefers-reduced-motion.
 */
export const terminalCursor = EditorView.theme({
  // Override CodeMirror's base thin line
  '.cm-cursor, .cm-dropCursor': {
    borderLeft: 'none !important',
    borderRight: 'none !important',
    border: 'none !important',
    width: '8px !important',
    borderRadius: '1px',
    pointerEvents: 'none',
    opacity: '0.88',
    animation: 'cm-terminal-cursor-blink-color 6s ease-in-out infinite',
  },

  // Fallback native caret color
  '.cm-content': {
    caretColor: '#10b981',
  },

  // LTR cursor alignment: block extends rightward over the next character spot
  '&[dir="ltr"] .cm-cursor, &[dir="ltr"] .cm-dropCursor, .direction-ltr .cm-cursor': {
    marginLeft: '0 !important',
  },

  // RTL cursor alignment: block extends leftward over the next character spot
  '&[dir="rtl"] .cm-cursor, &[dir="rtl"] .cm-dropCursor, .direction-rtl .cm-cursor': {
    marginLeft: '-8px !important',
  },

  // Selection background
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(16, 185, 129, 0.25) !important',
  },
  '&.cm-dark .cm-selectionBackground, .dark .cm-selectionBackground': {
    backgroundColor: 'rgba(16, 185, 129, 0.35) !important',
  },

  // Multi-color cycle:
  // Across 6s with CodeMirror's 1.2s blink cycle (5 blinks):
  // 1: #10b981 (Emerald)
  // 2: #06b6d4 (Cyan)
  // 3: #f59e0b (Amber)
  // 4: #a855f7 (Purple)
  // 5: #f43f5e (Rose)
  '@keyframes cm-terminal-cursor-blink-color': {
    '0%, 12%': {
      backgroundColor: '#10b981',
      boxShadow: '0 0 8px rgba(16, 185, 129, 0.75)',
    },
    '20%, 32%': {
      backgroundColor: '#06b6d4',
      boxShadow: '0 0 8px rgba(6, 182, 212, 0.75)',
    },
    '40%, 52%': {
      backgroundColor: '#f59e0b',
      boxShadow: '0 0 8px rgba(245, 158, 11, 0.75)',
    },
    '60%, 72%': {
      backgroundColor: '#a855f7',
      boxShadow: '0 0 8px rgba(168, 85, 247, 0.75)',
    },
    '80%, 92%': {
      backgroundColor: '#f43f5e',
      boxShadow: '0 0 8px rgba(244, 63, 94, 0.75)',
    },
    '98%, 100%': {
      backgroundColor: '#10b981',
      boxShadow: '0 0 8px rgba(16, 185, 129, 0.75)',
    },
  },

  '@media (prefers-reduced-motion: reduce)': {
    '.cm-cursor, .cm-dropCursor': {
      animation: 'none',
      backgroundColor: 'var(--primary, #10b981)',
      boxShadow: 'none',
    },
  },
})
