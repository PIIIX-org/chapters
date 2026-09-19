import { useState, useEffect, type ReactNode } from 'react'
import type { EditorView } from '@codemirror/view'
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Highlighter,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Table,
  Minus,
  Link2,
  FileText,
  Undo2,
  Redo2,
  Maximize2,
  Columns2,
  Smartphone,
  Monitor,
} from 'lucide-react'
import { cn } from '../../lib/utils.js'
import {
  type NoteWidth,
  applyFormat,
} from './note-toolbar-utils.js'

interface ToolbarButtonProps {
  label: string
  icon: ReactNode
  onClick: () => void
  active?: boolean
  disabled?: boolean
}

function ToolbarButton({ label, icon, onClick, active, disabled }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-all duration-100',
        'hover:bg-muted hover:text-foreground hover:scale-105',
        'active:scale-95 active:bg-muted/80',
        'focus-visible:ring-2 focus-visible:ring-ring/40 outline-none',
        active && 'bg-muted text-primary font-semibold',
        disabled && 'opacity-40 pointer-events-none',
      )}
    >
      {icon}
    </button>
  )
}

interface NoteRichToolbarProps {
  view: EditorView | null
  readOnly?: boolean
  width: NoteWidth
  onWidthChange: (width: NoteWidth) => void
}

export function NoteRichToolbar({ view, readOnly, width, onWidthChange }: NoteRichToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-1 border-b border-border bg-card/60 px-3 py-1 text-xs backdrop-blur-xs select-none">
      {/* Formatting Tools */}
      <div className="flex flex-wrap items-center gap-0.5">
        {/* Undo / Redo */}
        <ToolbarButton
          label="Undo"
          icon={<Undo2 className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'undo')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Redo"
          icon={<Redo2 className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'redo')}
          disabled={readOnly}
        />

        <div className="mx-1 h-3.5 w-px bg-border shrink-0" />

        {/* Headings */}
        <ToolbarButton
          label="Heading 1"
          icon={<Heading1 className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'h1')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Heading 2"
          icon={<Heading2 className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'h2')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Heading 3"
          icon={<Heading3 className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'h3')}
          disabled={readOnly}
        />

        <div className="mx-1 h-3.5 w-px bg-border shrink-0" />

        {/* Text styling */}
        <ToolbarButton
          label="Bold"
          icon={<Bold className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'bold')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Italic"
          icon={<Italic className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'italic')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Strikethrough"
          icon={<Strikethrough className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'strike')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Inline Code"
          icon={<Code className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'code')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Highlight"
          icon={<Highlighter className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'highlight')}
          disabled={readOnly}
        />

        <div className="mx-1 h-3.5 w-px bg-border shrink-0" />

        {/* Lists */}
        <ToolbarButton
          label="Bullet List"
          icon={<List className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'bullet')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Numbered List"
          icon={<ListOrdered className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'number')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Task Checklist"
          icon={<ListTodo className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'task')}
          disabled={readOnly}
        />

        <div className="mx-1 h-3.5 w-px bg-border shrink-0" />

        {/* Blocks & Extras */}
        <ToolbarButton
          label="Quote"
          icon={<Quote className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'quote')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Code Block"
          icon={
            <span className="font-mono text-[11px] font-bold" aria-hidden="true">
              {'{ }'}
            </span>
          }
          onClick={() => applyFormat(view, 'codeblock')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Table"
          icon={<Table className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'table')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Horizontal Rule"
          icon={<Minus className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'hr')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="Wikilink [[Note]]"
          icon={<FileText className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'wikilink')}
          disabled={readOnly}
        />
        <ToolbarButton
          label="External Link [URL]"
          icon={<Link2 className="size-3.5" aria-hidden="true" />}
          onClick={() => applyFormat(view, 'link')}
          disabled={readOnly}
        />
      </div>

      {/* Note Area Adjustable Width Controls */}
      <div className="flex items-center gap-1 shrink-0 ml-auto pl-2">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider mr-1 hidden sm:inline">
          Width:
        </span>
        <div className="flex items-center rounded-md border border-border bg-background p-0.5" role="group" aria-label="Note width">
          <button
            type="button"
            onClick={() => onWidthChange('compact')}
            aria-label="Compact note width (680px)"
            title="Compact width (680px)"
            className={cn(
              'flex size-6 items-center justify-center rounded text-xs transition-colors',
              width === 'compact'
                ? 'bg-primary text-primary-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Smartphone className="size-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onWidthChange('standard')}
            aria-label="Standard note width (896px)"
            title="Standard width (896px)"
            className={cn(
              'flex size-6 items-center justify-center rounded text-xs transition-colors',
              width === 'standard'
                ? 'bg-primary text-primary-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Columns2 className="size-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onWidthChange('wide')}
            aria-label="Wide note width (1152px)"
            title="Wide width (1152px)"
            className={cn(
              'flex size-6 items-center justify-center rounded text-xs transition-colors',
              width === 'wide'
                ? 'bg-primary text-primary-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Monitor className="size-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onWidthChange('full')}
            aria-label="Full width (100%)"
            title="Full width (100%)"
            className={cn(
              'flex size-6 items-center justify-center rounded text-xs transition-colors',
              width === 'full'
                ? 'bg-primary text-primary-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Maximize2 className="size-3" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

interface FloatingToolbarCoords {
  top: number
  left: number
}

interface NoteFloatingSelectionToolbarProps {
  view: EditorView | null
  readOnly?: boolean
}

export function NoteFloatingSelectionToolbar({
  view,
  readOnly,
}: NoteFloatingSelectionToolbarProps) {
  const [coords, setCoords] = useState<FloatingToolbarCoords | null>(null)

  useEffect(() => {
    if (!view || readOnly) return

    const checkSelection = () => {
      const { from, to } = view.state.selection.main
      if (from === to) {
        setCoords(null)
        return
      }

      // Calculate position above selection
      try {
        const startCoords = view.coordsAtPos(from)
        const endCoords = view.coordsAtPos(to)
        if (!startCoords || !endCoords) {
          setCoords(null)
          return
        }

        const top = Math.min(startCoords.top, endCoords.top) - 42
        const left = (startCoords.left + endCoords.right) / 2
        setCoords({ top, left })
      } catch {
        setCoords(null)
      }
    }

    const dom = view.dom
    dom.addEventListener('mouseup', checkSelection)
    dom.addEventListener('keyup', checkSelection)

    return () => {
      dom.removeEventListener('mouseup', checkSelection)
      dom.removeEventListener('keyup', checkSelection)
    }
  }, [view, readOnly])

  if (!coords || !view || readOnly) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: `${Math.max(10, coords.top)}px`,
        left: `${coords.left}px`,
        transform: 'translateX(-50%)',
        zIndex: 50,
      }}
      className="flex items-center gap-0.5 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
      onMouseDown={(e) => {
        // Prevent losing selection on click
        e.preventDefault()
      }}
    >
      <button
        type="button"
        aria-label="Bold selected"
        title="Bold selected"
        onClick={() => applyFormat(view, 'bold')}
        className="inline-flex size-6 items-center justify-center rounded text-xs hover:bg-muted active:scale-95 transition-transform"
      >
        <Bold className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Italic selected"
        title="Italic selected"
        onClick={() => applyFormat(view, 'italic')}
        className="inline-flex size-6 items-center justify-center rounded text-xs hover:bg-muted active:scale-95 transition-transform"
      >
        <Italic className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Strikethrough selected"
        title="Strikethrough selected"
        onClick={() => applyFormat(view, 'strike')}
        className="inline-flex size-6 items-center justify-center rounded text-xs hover:bg-muted active:scale-95 transition-transform"
      >
        <Strikethrough className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Code selected"
        title="Code selected"
        onClick={() => applyFormat(view, 'code')}
        className="inline-flex size-6 items-center justify-center rounded text-xs hover:bg-muted active:scale-95 transition-transform"
      >
        <Code className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Highlight selected"
        title="Highlight selected"
        onClick={() => applyFormat(view, 'highlight')}
        className="inline-flex size-6 items-center justify-center rounded text-xs hover:bg-muted active:scale-95 transition-transform"
      >
        <Highlighter className="size-3" aria-hidden="true" />
      </button>

      <div className="mx-1 h-3 w-px bg-border shrink-0" />

      <button
        type="button"
        aria-label="Heading 1"
        title="Heading 1"
        onClick={() => applyFormat(view, 'h1')}
        className="inline-flex size-6 items-center justify-center rounded text-xs hover:bg-muted active:scale-95 transition-transform font-bold"
      >
        H1
      </button>
      <button
        type="button"
        aria-label="Heading 2"
        title="Heading 2"
        onClick={() => applyFormat(view, 'h2')}
        className="inline-flex size-6 items-center justify-center rounded text-xs hover:bg-muted active:scale-95 transition-transform font-bold"
      >
        H2
      </button>
      <button
        type="button"
        aria-label="Quote selected"
        title="Quote selected"
        onClick={() => applyFormat(view, 'quote')}
        className="inline-flex size-6 items-center justify-center rounded text-xs hover:bg-muted active:scale-95 transition-transform"
      >
        <Quote className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Link selected"
        title="Link selected"
        onClick={() => applyFormat(view, 'link')}
        className="inline-flex size-6 items-center justify-center rounded text-xs hover:bg-muted active:scale-95 transition-transform"
      >
        <Link2 className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Wikilink selected"
        title="Wikilink selected"
        onClick={() => applyFormat(view, 'wikilink')}
        className="inline-flex size-6 items-center justify-center rounded text-xs hover:bg-muted active:scale-95 transition-transform"
      >
        <FileText className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}
