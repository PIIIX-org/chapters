import { useState } from 'react'
import { Input } from '../ui/input'

interface TagInputProps {
  value: string[]
  onChange: (tags: string[]) => void
  disabled?: boolean
}

export function TagInput({ value, onChange, disabled }: TagInputProps) {
  const [draft, setDraft] = useState('')

  function addTag() {
    const tag = draft.trim()
    if (tag && !value.includes(tag)) onChange([...value, tag])
    setDraft('')
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(value.filter((t) => t !== tag))}
              aria-label={`Remove ${tag}`}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addTag()
            }
          }}
          placeholder="Add tag…"
          className="h-6 w-28 flex-1"
        />
      )}
    </div>
  )
}
