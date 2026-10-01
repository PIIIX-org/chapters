import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { RangeSetBuilder, StateField } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import DOMPurify from 'dompurify'

// Lazy dynamic import helper for mermaid to keep diagram engines out of the initial bundle
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null

function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const instance = m.default ?? m
      instance.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        fontFamily: 'inherit',
        theme: 'default',
      })
      return instance
    })
  }
  return mermaidPromise
}

let nextId = 0

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly from: number,
  ) {
    super()
  }

  override eq(other: MermaidWidget) {
    return this.code === other.code
  }

  override toDOM(view: EditorView) {
    const wrapper = document.createElement('div')
    wrapper.className =
      'cm-mermaid-container my-3 rounded-md border border-border bg-card/60 p-3 select-none cursor-pointer transition-colors hover:border-primary/50'
    wrapper.title = 'Click to edit diagram definition'

    const header = document.createElement('div')
    header.className =
      'flex items-center justify-between pb-2 mb-2 border-b border-border/50 text-[11px] font-mono text-muted-foreground'
    header.innerHTML = `
      <span class="font-medium text-foreground/80">Mermaid Diagram</span>
      <span class="text-[10px] text-muted-foreground/75">Click to edit</span>
    `
    wrapper.appendChild(header)

    const viewport = document.createElement('div')
    viewport.className = 'cm-mermaid-viewport flex items-center justify-center overflow-x-auto min-h-[60px]'
    viewport.innerHTML = '<span class="text-xs text-muted-foreground animate-pulse">Rendering diagram…</span>'
    wrapper.appendChild(viewport)

    const renderId = `mermaid-diagram-${++nextId}`

    getMermaid()
      .then((m) => m.render(renderId, this.code.trim()))
      .then(({ svg }) => {
        viewport.innerHTML = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
        })
        const svgEl = viewport.querySelector('svg')
        if (svgEl) {
          svgEl.style.maxWidth = '100%'
          svgEl.style.height = 'auto'
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        viewport.innerHTML = `<div class="rounded bg-destructive/10 p-2 text-xs font-mono text-destructive">Mermaid syntax error: ${msg.slice(0, 120)}</div>`
      })

    wrapper.onclick = (e) => {
      e.preventDefault()
      // Place cursor right after the ```mermaid fence on the first code line
      view.dispatch({
        selection: { anchor: this.from + 10 },
      })
      view.focus()
    }

    return wrapper
  }
}

interface MermaidBlock {
  from: number
  to: number
  code: string
}

export function findMermaidBlocks(doc: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = []
  const regex = /```mermaid\s*\n([\s\S]*?)\n```/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(doc)) !== null) {
    const from = match.index
    const to = from + match[0].length
    const code = match[1]!
    blocks.push({ from, to, code })
  }

  return blocks.sort((a, b) => a.from - b.from)
}

let cachedDoc: unknown = null
let cachedBlocks: MermaidBlock[] = []

function getBlocks(doc: { toString(): string }): MermaidBlock[] {
  if (doc === cachedDoc) return cachedBlocks
  cachedDoc = doc
  cachedBlocks = findMermaidBlocks(doc.toString())
  return cachedBlocks
}

function buildMermaidDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()

  const activeRanges = state.selection.ranges
  const isSelected = (from: number, to: number) =>
    activeRanges.some((r) => r.from <= to && r.to >= from)

  const blocks = getBlocks(state.doc)

  for (const block of blocks) {
    if (!isSelected(block.from, block.to)) {
      builder.add(
        block.from,
        block.to,
        Decoration.replace({
          widget: new MermaidWidget(block.code, block.from),
          block: true,
        }),
      )
    }
  }

  return builder.finish()
}

export const mermaidLivePreview = StateField.define<DecorationSet>({
  create(state) {
    return buildMermaidDecorations(state)
  },
  update(decorations, tr) {
    if (!tr.docChanged) {
      if (!tr.selection) return decorations
      const blocks = cachedBlocks
      if (blocks.length === 0) return decorations

      const prevRanges = tr.startState.selection.ranges
      const currRanges = tr.newSelection.ranges

      let changed = false
      for (const b of blocks) {
        const wasIn = prevRanges.some((r) => r.from <= b.to && r.to >= b.from)
        const isIn = currRanges.some((r) => r.from <= b.to && r.to >= b.from)
        if (wasIn !== isIn) {
          changed = true
          break
        }
      }
      if (!changed) return decorations
    }
    return buildMermaidDecorations(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})
