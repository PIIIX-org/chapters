import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Edit2, Trash2 } from 'lucide-react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { FormError } from '../FormError'
import { useRenameNote } from '../../hooks/useRenameNote'
import { useDeleteNote } from '../../hooks/useDeleteNote'
import type { NoteSummary } from '../../api/notes'
import { cn } from '../../lib/utils'

const SLUG = /^[a-z0-9][a-z0-9-]*$/

interface NoteActionsProps {
  vaultId: string
  /** Just the identity the actions need: FileTree hands over a full
   *  NoteSummary; the note bar has only the path on hand. */
  note: Pick<NoteSummary, 'path' | 'name'>
  compact?: boolean
}

export function NoteActions({ vaultId, note, compact = false }: NoteActionsProps) {
  const [mode, setMode] = useState<'idle' | 'renaming' | 'confirmDelete'>('idle')
  const [name, setName] = useState(note.name)
  const [error, setError] = useState<string | null>(null)
  const renameNote = useRenameNote(vaultId)
  const deleteNote = useDeleteNote(vaultId)
  const navigate = useNavigate()
  const isOpen = useParams()['*'] === note.path

  function submitRename(e: FormEvent) {
    e.preventDefault()
    if (!SLUG.test(name)) {
      setError('Name must be lowercase letters, numbers, and hyphens.')
      return
    }
    setError(null)
    renameNote.mutate(
      { from: note.path, to: name },
      {
        onSuccess: (renamed) => {
          setMode('idle')
          if (isOpen) navigate(`/vaults/${vaultId}/notes/${renamed.path}`)
        },
        onError: (err) => setError(err.message || 'Could not rename the note.'),
      },
    )
  }

  function confirmDelete() {
    setError(null)
    deleteNote.mutate(note.path, {
      onSuccess: () => {
        setMode('idle')
        if (isOpen) navigate(`/vaults/${vaultId}`)
      },
      onError: (err) => setError(err.message || 'Could not delete the note.'),
    })
  }

  if (mode === 'renaming') {
    return (
      <form onSubmit={submitRename} className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="New name" className="h-6" />
          <Button type="submit" size="xs" disabled={renameNote.isPending}>Save</Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              setMode('idle')
              setName(note.name)
              setError(null)
            }}
          >
            Cancel
          </Button>
        </div>
        <FormError message={error} />
      </form>
    )
  }

  if (mode === 'confirmDelete') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Delete?</span>
          <Button type="button" size="xs" variant="destructive" onClick={confirmDelete} disabled={deleteNote.isPending}>
            Delete
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => { setMode('idle'); setError(null) }}>
            Cancel
          </Button>
        </div>
        <FormError message={error} />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setMode('renaming')}
        aria-label={`Rename ${note.name}`}
        title={`Rename ${note.name}`}
        className={cn(
          "inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/80 active:bg-muted active:scale-95 rounded-md border border-border/50 hover:border-border transition-all duration-100 touch-manipulation cursor-pointer shadow-xs focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none shrink-0",
          compact ? "size-6 p-0" : "gap-1 px-2 py-0.5 text-xs font-medium"
        )}
      >
        <Edit2 className="size-3 shrink-0" aria-hidden="true" />
        <span className={compact ? "sr-only" : undefined}>Rename</span>
      </button>
      <button
        type="button"
        onClick={() => setMode('confirmDelete')}
        aria-label={`Delete ${note.name}`}
        title={`Delete ${note.name}`}
        className={cn(
          "inline-flex items-center justify-center text-destructive/80 hover:text-destructive hover:bg-destructive/15 active:bg-destructive/25 active:scale-95 rounded-md border border-destructive/20 hover:border-destructive/40 transition-all duration-100 touch-manipulation cursor-pointer shadow-xs focus-visible:ring-2 focus-visible:ring-destructive/50 focus-visible:outline-none shrink-0",
          compact ? "size-6 p-0" : "gap-1 px-2 py-0.5 text-xs font-medium"
        )}
      >
        <Trash2 className="size-3 shrink-0" aria-hidden="true" />
        <span className={compact ? "sr-only" : undefined}>Delete</span>
      </button>
    </div>
  )
}
