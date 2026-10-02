import { useState } from 'react'
import type { FormEvent } from 'react'
import { Check, X } from 'lucide-react'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { FormError } from '../FormError'
import { useCreateNote } from '../../hooks/useCreateNote'
import type { CreateNoteResult } from '../../api/notes'
import { cn } from '../../lib/utils'

const SLUG = /^[a-z0-9][a-z0-9-]*$/

interface NewNoteFormProps {
  vaultId: string
  existingTypes: string[]
  onCreated: (note: CreateNoteResult) => void
}

function SlugRequirements({ value }: { value: string }) {
  if (!value) return null
  const startsValid = /^[a-z0-9]/.test(value)
  const charsValid = /^[a-z0-9-]*$/.test(value)

  return (
    <div className="mt-1 flex flex-col gap-1 text-[11px]" role="status" aria-live="polite">
      <div
        className={cn(
          'flex items-center gap-1.5 transition-colors',
          startsValid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400',
        )}
      >
        {startsValid ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
        <span>Starts with a lowercase letter or number</span>
      </div>
      <div
        className={cn(
          'flex items-center gap-1.5 transition-colors',
          charsValid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400',
        )}
      >
        {charsValid ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
        <span>Lowercase letters, numbers, and hyphens only</span>
      </div>
    </div>
  )
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
        onSuccess: (note) => onCreated(note),
        onError: (err) => setServerError(err.message || 'Could not create the note.'),
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
