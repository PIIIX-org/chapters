import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { FormError } from '../FormError'
import { useCreateNote } from '../../hooks/useCreateNote'
import type { CreateNoteResult } from '../../api/notes'
import { cn } from '../../lib/utils'

import { SLUG, SlugRequirements } from './SlugRequirements.js'
import { toast } from '../../lib/toast.js'

interface NewNoteFormProps {
  vaultId: string
  existingTypes: string[]
  onCreated: (note: CreateNoteResult) => void
}

export function NewNoteForm({ vaultId, existingTypes, onCreated }: NewNoteFormProps) {
  const [type, setType] = useState('')
  const [name, setName] = useState('')
  const [typeError, setTypeError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const createNote = useCreateNote(vaultId)

  const isTypeValid = SLUG.test(type)
  const isNameValid = SLUG.test(name)

  function handleTypeChange(val: string) {
    setType(val)
    if (typeError && SLUG.test(val)) {
      setTypeError(null)
    }
  }

  function handleNameChange(val: string) {
    setName(val)
    if (nameError && SLUG.test(val)) {
      setNameError(null)
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitted(true)

    let hasError = false
    if (!SLUG.test(type)) {
      setTypeError('Type must be lowercase letters, numbers, and hyphens.')
      hasError = true
    } else {
      setTypeError(null)
    }

    if (!SLUG.test(name)) {
      setNameError('Name must be lowercase letters, numbers, and hyphens.')
      hasError = true
    } else {
      setNameError(null)
    }

    if (hasError) {
      return
    }

    setServerError(null)
    createNote.mutate(
      { type, name },
      {
        onSuccess: (note) => {
          toast.success('Note created', `${note.name || name} created successfully.`)
          onCreated(note)
        },
        onError: (err) => {
          const msg = err.message || 'Could not create the note.'
          toast.error('Failed to create note', msg)
          setServerError(msg)
        },
      },
    )
  }

  const showTypeInvalid = (submitted || type.length > 0) && !isTypeValid
  const showTypeValid = type.length > 0 && isTypeValid
  const showNameInvalid = (submitted || name.length > 0) && !isNameValid
  const showNameValid = name.length > 0 && isNameValid

  return (
    <form onSubmit={handleSubmit} className="mb-4 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="nn-type">Type</Label>
        <Input
          id="nn-type"
          list="nn-types"
          value={type}
          onChange={(e) => handleTypeChange(e.target.value)}
          placeholder="e.g. people"
          aria-invalid={showTypeInvalid}
          aria-describedby={typeError ? 'nn-type-error' : undefined}
          className={cn(
            showTypeValid && 'border-emerald-500 focus-visible:ring-emerald-500/30',
            showTypeInvalid && 'border-red-500 focus-visible:ring-red-500/30',
          )}
        />
        <datalist id="nn-types">
          {existingTypes.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <SlugRequirements value={type} />
        {typeError && (
          <p id="nn-type-error" className="text-xs font-medium text-red-500" role="alert">
            {typeError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="nn-name">Name</Label>
        <Input
          id="nn-name"
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="e.g. jane-doe"
          aria-invalid={showNameInvalid}
          aria-describedby={nameError ? 'nn-name-error' : undefined}
          className={cn(
            showNameValid && 'border-emerald-500 focus-visible:ring-emerald-500/30',
            showNameInvalid && 'border-red-500 focus-visible:ring-red-500/30',
          )}
        />
        <SlugRequirements value={name} />
        {nameError && (
          <p id="nn-name-error" className="text-xs font-medium text-red-500" role="alert">
            {nameError}
          </p>
        )}
      </div>

      <FormError message={serverError} />

      <Button type="submit" disabled={createNote.isPending}>
        {createNote.isPending ? 'Creating…' : 'Create note'}
      </Button>
    </form>
  )
}
