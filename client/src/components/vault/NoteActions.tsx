import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { FormError } from '../FormError'
import { useRenameNote } from '../../hooks/useRenameNote'
import { useDeleteNote } from '../../hooks/useDeleteNote'
import type { NoteSummary } from '../../api/notes'

const SLUG = /^[a-z0-9][a-z0-9-]*$/

interface NoteActionsProps {
  vaultId: string
  /** Just the identity the actions need: FileTree hands over a full
   *  NoteSummary; the note bar has only the path on hand. */
  note: Pick<NoteSummary, 'path' | 'name'>
}

export function NoteActions({ vaultId, note }: NoteActionsProps) {
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
        className="rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Rename
      </button>
      <button
        type="button"
        onClick={() => setMode('confirmDelete')}
        aria-label={`Delete ${note.name}`}
        className="rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Delete
      </button>
    </div>
  )
}
