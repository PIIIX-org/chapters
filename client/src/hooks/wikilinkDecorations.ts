import { Decoration, EditorView, MatchDecorator, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

const matcher = new MatchDecorator({
  regexp: /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g,
  decoration: (match) =>
    Decoration.mark({
      class: 'cm-wikilink',
      attributes: { 'data-wikilink-target': match[1]!.trim() },
    }),
})

const wikilinkView = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = matcher.createDeco(view)
    }
    update(update: ViewUpdate) {
      this.decorations = matcher.updateDeco(update, this.decorations)
    }
  },
  { decorations: (v) => v.decorations },
)

function clickHandler(onClick: (target: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (event.button !== 0) return false
      const el = (event.target as HTMLElement | null)?.closest('.cm-wikilink') as HTMLElement | null
      if (!el) return false
      const target = el.getAttribute('data-wikilink-target')
      if (!target) return false
      // On the line the cursor already occupies → let the click place the
      // cursor (edit the source). Otherwise the link is "rendered" → navigate.
      const line = view.state.doc.lineAt(view.posAtDOM(el))
      const editing = view.state.selection.ranges.some((r) => {
        const from = view.state.doc.lineAt(r.from).from
        const to = view.state.doc.lineAt(r.to).to
        return line.from >= from && line.to <= to
      })
      if (editing) return false
      event.preventDefault()
      onClick(target)
      return true
    },
  })
}

export function wikilinkExtension(onClick: (target: string) => void): Extension {
  return [wikilinkView, clickHandler(onClick)]
}
