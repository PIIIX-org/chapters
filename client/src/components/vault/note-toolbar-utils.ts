import { useState, useCallback } from 'react'
import type { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'

export type NoteWidth = 'compact' | 'standard' | 'wide' | 'full'

export const NOTE_WIDTH_CLASSES: Record<NoteWidth, string> = {
  compact: 'max-w-2xl',
  standard: 'max-w-4xl',
  wide: 'max-w-6xl',
  full: 'max-w-full',
}

const WIDTH_STORAGE_KEY = 'chapters:note-width-preference'

export function useNoteWidth() {
  const [width, setWidth] = useState<NoteWidth>(() => {
    if (typeof localStorage === 'undefined') return 'standard'
    const stored = localStorage.getItem(WIDTH_STORAGE_KEY)
    if (stored === 'compact' || stored === 'standard' || stored === 'wide' || stored === 'full') {
      return stored
    }
    return 'standard'
  })

  const updateWidth = useCallback((newWidth: NoteWidth) => {
    setWidth(newWidth)
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, newWidth)
    } catch {
      // Ignore quota error
    }
  }, [])

  return [width, updateWidth] as const
}

export type NoteDirection = 'ltr' | 'rtl'

const RTL_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0590-\u05FF]/

export function detectTextDirection(text?: string | null): NoteDirection {
  if (!text) return 'ltr'
  const sample = text.slice(0, 1000)
  return RTL_REGEX.test(sample) ? 'rtl' : 'ltr'
}

export function getNoteDirectionKey(vaultId?: string, path?: string): string {
  if (vaultId && path) {
    return `chapters:note-direction:${vaultId}:${path}`
  }
  return 'chapters:note-direction-default'
}

function readStoredDirection(vaultId?: string, path?: string, initialBody?: string): NoteDirection {
  if (typeof localStorage === 'undefined') return detectTextDirection(initialBody)
  const specificKey = getNoteDirectionKey(vaultId, path)
  const stored = localStorage.getItem(specificKey)
  if (stored === 'ltr' || stored === 'rtl') return stored
  const defaultStored = localStorage.getItem('chapters:note-direction-default')
  if (defaultStored === 'ltr' || defaultStored === 'rtl') return defaultStored
  return detectTextDirection(initialBody)
}

export function useNoteDirection(vaultId?: string, path?: string, initialBody?: string) {
  const noteKey = `${vaultId ?? ''}:${path ?? ''}`
  const [prevKey, setPrevKey] = useState(noteKey)
  const [direction, setDirection] = useState<NoteDirection>(() => readStoredDirection(vaultId, path, initialBody))

  if (prevKey !== noteKey) {
    setPrevKey(noteKey)
    setDirection(readStoredDirection(vaultId, path, initialBody))
  }

  const updateDirection = useCallback(
    (newDirection: NoteDirection) => {
      setDirection(newDirection)
      try {
        const specificKey = getNoteDirectionKey(vaultId, path)
        localStorage.setItem(specificKey, newDirection)
        localStorage.setItem('chapters:note-direction-default', newDirection)
      } catch {
        // Ignore quota error
      }
    },
    [vaultId, path],
  )

  return [direction, updateDirection] as const
}

export type FormatType =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'highlight'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'quote'
  | 'codeblock'
  | 'bullet'
  | 'number'
  | 'task'
  | 'table'
  | 'hr'
  | 'wikilink'
  | 'link'
  | 'undo'
  | 'redo'

export function applyFormat(view: EditorView | null, format: FormatType) {
  if (!view) return

  if (format === 'undo') {
    undo(view)
    return
  }
  if (format === 'redo') {
    redo(view)
    return
  }

  const { from, to } = view.state.selection.main
  const hasSelection = from !== to
  const selected = view.state.sliceDoc(from, to)

  switch (format) {
    case 'bold': {
      const text = hasSelection ? selected : 'bold text'
      view.dispatch({
        changes: { from, to, insert: `**${text}**` },
        selection: { anchor: from + 2, head: from + 2 + text.length },
      })
      break
    }
    case 'italic': {
      const text = hasSelection ? selected : 'italic text'
      view.dispatch({
        changes: { from, to, insert: `*${text}*` },
        selection: { anchor: from + 1, head: from + 1 + text.length },
      })
      break
    }
    case 'strike': {
      const text = hasSelection ? selected : 'strikethrough text'
      view.dispatch({
        changes: { from, to, insert: `~~${text}~~` },
        selection: { anchor: from + 2, head: from + 2 + text.length },
      })
      break
    }
    case 'code': {
      const text = hasSelection ? selected : 'code'
      view.dispatch({
        changes: { from, to, insert: `\`${text}\`` },
        selection: { anchor: from + 1, head: from + 1 + text.length },
      })
      break
    }
    case 'highlight': {
      const text = hasSelection ? selected : 'highlighted text'
      view.dispatch({
        changes: { from, to, insert: `==${text}==` },
        selection: { anchor: from + 2, head: from + 2 + text.length },
      })
      break
    }
    case 'wikilink': {
      const text = hasSelection ? selected : 'note'
      view.dispatch({
        changes: { from, to, insert: `[[${text}]]` },
        selection: { anchor: from + 2, head: from + 2 + text.length },
      })
      break
    }
    case 'link': {
      const text = hasSelection ? selected : 'link text'
      const insert = `[${text}](https://)`
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length - 9, head: from + insert.length - 1 },
      })
      break
    }
    case 'h1':
    case 'h2':
    case 'h3': {
      const hashes = format === 'h1' ? '# ' : format === 'h2' ? '## ' : '### '
      const line = view.state.doc.lineAt(from)
      const currentText = line.text
      const stripped = currentText.replace(/^#{1,6}\s*/, '')
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: `${hashes}${stripped}` },
        selection: { anchor: line.from + hashes.length + stripped.length },
      })
      break
    }
    case 'quote': {
      const line = view.state.doc.lineAt(from)
      const isQuote = line.text.startsWith('> ')
      const insert = isQuote ? line.text.slice(2) : `> ${line.text}`
      view.dispatch({
        changes: { from: line.from, to: line.to, insert },
        selection: { anchor: line.from + insert.length },
      })
      break
    }
    case 'bullet': {
      const line = view.state.doc.lineAt(from)
      const isBullet = line.text.startsWith('- ')
      const insert = isBullet ? line.text.slice(2) : `- ${line.text}`
      view.dispatch({
        changes: { from: line.from, to: line.to, insert },
        selection: { anchor: line.from + insert.length },
      })
      break
    }
    case 'number': {
      const line = view.state.doc.lineAt(from)
      const isNumbered = /^\d+\.\s*/.test(line.text)
      const insert = isNumbered ? line.text.replace(/^\d+\.\s*/, '') : `1. ${line.text}`
      view.dispatch({
        changes: { from: line.from, to: line.to, insert },
        selection: { anchor: line.from + insert.length },
      })
      break
    }
    case 'task': {
      const line = view.state.doc.lineAt(from)
      const isTask = line.text.startsWith('- [ ] ') || line.text.startsWith('- [x] ')
      const insert = isTask ? line.text.replace(/^- \[[ x]\]\s*/, '') : `- [ ] ${line.text}`
      view.dispatch({
        changes: { from: line.from, to: line.to, insert },
        selection: { anchor: line.from + insert.length },
      })
      break
    }
    case 'codeblock': {
      const text = hasSelection ? selected : '// code here'
      const insert = `\`\`\`\n${text}\n\`\`\`\n`
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + 4, head: from + 4 + text.length },
      })
      break
    }
    case 'table': {
      const insert = `| Column 1 | Column 2 | Column 3 |\n|---|---|---|\n| Item 1 | Item 2 | Item 3 |\n`
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      })
      break
    }
    case 'hr': {
      const insert = `\n---\n`
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      })
      break
    }
  }
}
