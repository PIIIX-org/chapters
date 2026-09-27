import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { RangeSetBuilder, StateField } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { uploadAsset } from '../api/assets.js'

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly from: number,
  ) {
    super()
  }

  override eq(other: ImageWidget) {
    return this.src === other.src && this.alt === other.alt
  }

  override toDOM(view: EditorView) {
    const container = document.createElement('div')
    container.className =
      'cm-image-container my-2 inline-block max-w-full select-none cursor-pointer'
    container.title = 'Click to edit image markdown'

    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt || 'Note image'
    img.loading = 'lazy'
    img.className =
      'rounded-md border border-border max-h-[480px] max-w-full object-contain hover:border-primary/50 transition-colors'
    img.onerror = () => {
      container.innerHTML = `<span class="inline-flex items-center gap-1.5 rounded bg-muted/60 px-2 py-1 text-xs text-muted-foreground border border-border/50"><span>🖼</span><span>Image not found: ${this.alt || this.src}</span></span>`
    }

    container.appendChild(img)

    container.onclick = (e) => {
      e.preventDefault()
      view.dispatch({
        selection: { anchor: this.from + 2 },
      })
      view.focus()
    }

    return container
  }
}

export interface ImageItem {
  from: number
  to: number
  alt: string
  src: string
}

export function findImageMarkdown(doc: string): ImageItem[] {
  const items: ImageItem[] = []
  // Matches ![alt](src)
  const regex = /!\[([^\]]*)\]\(([^)]+)\)/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(doc)) !== null) {
    items.push({
      from: match.index,
      to: match.index + match[0].length,
      alt: match[1] ?? '',
      src: match[2]?.trim() ?? '',
    })
  }

  return items
}

function buildImageDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const items = findImageMarkdown(state.doc.toString())

  if (items.length === 0) return builder.finish()

  const cursorRanges = state.selection.ranges

  for (const item of items) {
    // If selection touches image range, leave raw markdown visible for editing
    const cursorInside = cursorRanges.some((r) => r.from <= item.to && r.to >= item.from)
    if (cursorInside) continue

    builder.add(
      item.from,
      item.to,
      Decoration.replace({
        widget: new ImageWidget(item.src, item.alt, item.from),
        block: true,
      }),
    )
  }

  return builder.finish()
}

export const imageLivePreview = StateField.define<DecorationSet>({
  create(state) {
    return buildImageDecorations(state)
  },
  update(decorations, transaction) {
    if (transaction.docChanged || transaction.selection) {
      return buildImageDecorations(transaction.state)
    }
    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

export async function uploadAndInsertImage(
  view: EditorView,
  vaultId: string,
  file: File | Blob,
  fileName = 'image.png',
  targetPos?: number,
): Promise<void> {
  const insertPos = targetPos ?? view.state.selection.main.head
  const name = file instanceof File ? file.name : fileName
  const placeholder = `![Uploading ${name}...]()`

  view.dispatch({
    changes: { from: insertPos, to: insertPos, insert: `\n${placeholder}\n` },
  })

  try {
    const res = await uploadAsset(vaultId, file, name)
    const docStr = view.state.doc.toString()
    const phIndex = docStr.indexOf(placeholder)
    if (phIndex !== -1) {
      view.dispatch({
        changes: {
          from: phIndex,
          to: phIndex + placeholder.length,
          insert: `![${name}](/api/vaults/${encodeURIComponent(vaultId)}/assets/${encodeURIComponent(res.fileName)})`,
        },
      })
    }
  } catch (err) {
    const docStr = view.state.doc.toString()
    const phIndex = docStr.indexOf(placeholder)
    if (phIndex !== -1) {
      const msg = err instanceof Error ? err.message : String(err)
      view.dispatch({
        changes: {
          from: phIndex,
          to: phIndex + placeholder.length,
          insert: `<!-- Upload failed: ${msg} -->`,
        },
      })
    }
  }
}

export function imagePasteDropHandler(vaultId?: string) {
  if (!vaultId) return []

  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items
      if (!items) return false

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            event.preventDefault()
            void uploadAndInsertImage(view, vaultId, file)
            return true
          }
        }
      }
      return false
    },
    drop(event, view) {
      const files = event.dataTransfer?.files
      if (!files || files.length === 0) return false

      let handled = false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        if (
          file &&
          (file.type.startsWith('image/') ||
            /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(file.name))
        ) {
          if (!handled) {
            event.preventDefault()
            handled = true
          }
          void uploadAndInsertImage(view, vaultId, file, file.name, pos ?? undefined)
        }
      }
      return handled
    },
  })
}
