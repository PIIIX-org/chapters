import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { RangeSetBuilder, StateField } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import katex from 'katex'

class MathWidget extends WidgetType {
  constructor(
    readonly expr: string,
    readonly displayMode: boolean,
    readonly from: number,
  ) {
    super()
  }

  override eq(other: MathWidget) {
    return this.expr === other.expr && this.displayMode === other.displayMode
  }

  override toDOM(view: EditorView) {
    const el = document.createElement(this.displayMode ? 'div' : 'span')
    el.className = this.displayMode
      ? 'cm-math-block my-2 py-1 text-center select-none cursor-pointer'
      : 'cm-math-inline px-0.5 inline-block select-none cursor-pointer'
    el.title = 'Click to edit formula'

    try {
      el.innerHTML = katex.renderToString(this.expr, {
        displayMode: this.displayMode,
        throwOnError: false,
      })
    } catch {
      el.textContent = this.expr
      el.className += ' text-destructive font-mono text-xs'
    }

    el.onclick = (e) => {
      e.preventDefault()
      view.dispatch({
        selection: { anchor: this.from + 1 },
      })
      view.focus()
    }

    return el
  }
}

interface MathItem {
  from: number
  to: number
  expr: string
  displayMode: boolean
}

export function findMathExpressions(doc: string): MathItem[] {
  const items: MathItem[] = []

  // 1. Block math: $$ ... $$
  const blockRegex = /\$\$([\s\S]+?)\$\$/g
  const blockRanges: Array<[number, number]> = []
  let match: RegExpExecArray | null

  while ((match = blockRegex.exec(doc)) !== null) {
    const from = match.index
    const to = from + match[0].length
    blockRanges.push([from, to])
    const expr = match[1]!.trim()
    if (expr) {
      items.push({ from, to, expr, displayMode: true })
    }
  }

  // 2. Inline math: $ ... $ (excluding block math ranges)
  const inlineRegex = /(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g
  while ((match = inlineRegex.exec(doc)) !== null) {
    const from = match.index
    const to = from + match[0].length

    const insideBlock = blockRanges.some(([bFrom, bTo]) => from >= bFrom && to <= bTo)
    if (!insideBlock) {
      const expr = match[1]!.trim()
      if (expr) {
        items.push({ from, to, expr, displayMode: false })
      }
    }
  }

  // RangeSetBuilder requires strictly ascending order of `from`
  return items.sort((a, b) => a.from - b.from)
}

function buildMathDecorations(state: EditorState): DecorationSet {
  const doc = state.doc.toString()
  const builder = new RangeSetBuilder<Decoration>()

  const activeRanges = state.selection.ranges
  const isSelected = (from: number, to: number) =>
    activeRanges.some((r) => r.from <= to && r.to >= from)

  const items = findMathExpressions(doc)

  for (const item of items) {
    if (!isSelected(item.from, item.to)) {
      builder.add(
        item.from,
        item.to,
        Decoration.replace({
          widget: new MathWidget(item.expr, item.displayMode, item.from),
          block: item.displayMode,
        }),
      )
    }
  }

  return builder.finish()
}

export const mathLivePreview = StateField.define<DecorationSet>({
  create(state) {
    return buildMathDecorations(state)
  },
  update(decorations, tr) {
    if (tr.docChanged || tr.selection) {
      return buildMathDecorations(tr.state)
    }
    return decorations
  },
  provide: (f) => EditorView.decorations.from(f),
})
