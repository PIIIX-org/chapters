import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

// Punctuation markers hidden at rest and revealed on the cursor's line.
const HIDDEN_MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark'])
const hidden = Decoration.replace({})

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  // Line spans the selection touches — markers on these stay visible for editing.
  const active = state.selection.ranges.map((r) => {
    const from = state.doc.lineAt(r.from).from
    const to = state.doc.lineAt(r.to).to
    return [from, to] as const
  })
  const onActiveLine = (from: number, to: number) =>
    active.some(([lo, hi]) => from >= lo && to <= hi)

  const builder = new RangeSetBuilder<Decoration>()
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.to <= node.from) return
      if (!HIDDEN_MARKS.has(node.name)) return
      if (onActiveLine(node.from, node.to)) return
      // Skip markers that span a whole line rather than inline punctuation:
      // a fenced-code fence (```) and a Setext underline (====) each occupy
      // their own line, so hiding them would blank the line. Keep them visible.
      const parent = node.node.parent?.name
      if (parent === 'FencedCode' || parent?.startsWith('Setext')) return
      // Hide the heading '#' plus its trailing space so '# H' renders as 'H'.
      let to = node.to
      if (node.name === 'HeaderMark' && state.doc.sliceString(to, to + 1) === ' ') to += 1
      builder.add(node.from, to, hidden)
    },
  })
  return builder.finish()
}

export const markdownMarkerHiding = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)
