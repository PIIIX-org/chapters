import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { useCreateNote } from '../../hooks/useCreateNote'
import type { CreateNoteResult } from '../../api/notes'

const SLUG = /^[a-z0-9][a-z0-9-]*$/

interface NewNoteFormProps {
  vaultId: string
  existingTypes: string[]
  onCreated: (note: CreateNoteResult) => void
}

export function NewNoteForm({ vaultId, existingTypes, onCreated }: NewNoteFormProps) {
  const [type, setType] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const createNote = useCreateNote(vaultId)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!SLUG.test(type)) {
      setError('Type must be lowercase letters, numbers, and hyphens.')
      return
    }
    if (!SLUG.test(name)) {
      setError('Name must be lowercase letters, numbers, and hyphens.')
      return
    }
    setError(null)
    createNote.mutate(
      { type, name },
      {
        onSuccess: (note) => onCreated(note),
        onError: (err) => setError(err.message || 'Could not create the note.'),
      },
    )
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4 flex flex-col gap-2">
      <Label htmlFor="nn-type">Type</Label>
      <Input
        id="nn-type"
        list="nn-types"
        value={type}
        onChange={(e) => setType(e.target.value)}
        placeholder="e.g. people"
      />
      <datalist id="nn-types">
        {existingTypes.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <Label htmlFor="nn-name">Name</Label>
      <Input
        id="nn-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. jane-doe"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" disabled={createNote.isPending}>
        {createNote.isPending ? 'Creating…' : 'Create note'}
      </Button>
    </form>
  )
}
