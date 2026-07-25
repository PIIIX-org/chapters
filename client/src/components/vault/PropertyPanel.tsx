import { useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { TagInput } from './TagInput'
import { useUpdateNote } from '../../hooks/useUpdateNote'

const SAVE_DEBOUNCE_MS = 1200

interface PropertyPanelProps {
  vaultId: string
  path: string
  initialFrontmatter: Record<string, unknown>
  readOnly: boolean
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function PropertyPanel({ vaultId, path, initialFrontmatter, readOnly }: PropertyPanelProps) {
  const updateNote = useUpdateNote(vaultId, path)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Everything except the three editable standard keys is preserved as-is
  // (`type` — immutable server-side — and any extra OKF keys).
  const preserved = useMemo(() => {
    const omit = new Set(['resource', 'tags', 'timestamp'])
    return Object.fromEntries(Object.entries(initialFrontmatter).filter(([key]) => !omit.has(key)))
  }, [initialFrontmatter])

  const [resource, setResource] = useState(asString(initialFrontmatter.resource))
  const [tags, setTags] = useState<string[]>(asStringArray(initialFrontmatter.tags))
  const [timestamp, setTimestamp] = useState(asString(initialFrontmatter.timestamp))

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function scheduleSave(next: { resource: string; tags: string[]; timestamp: string }) {
    if (readOnly) return
    const frontmatter: Record<string, unknown> = { ...preserved }
    if (next.resource.trim()) frontmatter.resource = next.resource.trim()
    if (next.tags.length) frontmatter.tags = next.tags
    if (next.timestamp.trim()) frontmatter.timestamp = next.timestamp.trim()
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => updateNote.mutate({ frontmatter }), SAVE_DEBOUNCE_MS)
  }

  function onResource(v: string) {
    setResource(v)
    scheduleSave({ resource: v, tags, timestamp })
  }
  function onTags(v: string[]) {
    setTags(v)
    scheduleSave({ resource, tags: v, timestamp })
  }
  function onTimestamp(v: string) {
    setTimestamp(v)
    scheduleSave({ resource, tags, timestamp: v })
  }

  const extraKeys = Object.entries(preserved).filter(([key]) => key !== 'type')

  return (
    <dl className="grid grid-cols-[6rem_1fr] items-center gap-x-4 gap-y-2 text-sm">
      <dt className="font-medium text-muted-foreground">type</dt>
      <dd className="text-foreground">{asString(initialFrontmatter.type) || '—'}</dd>

      <Label htmlFor="pp-resource" className="text-muted-foreground">resource</Label>
      <Input
        id="pp-resource"
        value={resource}
        disabled={readOnly}
        onChange={(e) => onResource(e.target.value)}
      />

      <dt className="font-medium text-muted-foreground">tags</dt>
      <dd>
        <TagInput value={tags} onChange={onTags} disabled={readOnly} />
      </dd>

      <Label htmlFor="pp-timestamp" className="text-muted-foreground">timestamp</Label>
      <Input
        id="pp-timestamp"
        value={timestamp}
        disabled={readOnly}
        placeholder="ISO date (e.g. 2026-01-01)"
        onChange={(e) => onTimestamp(e.target.value)}
      />

      {extraKeys.map(([key, value]) => (
        <div key={key} className="col-span-2 flex gap-2">
          <dt className="font-medium text-muted-foreground">{key}:</dt>
          <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  )
}
