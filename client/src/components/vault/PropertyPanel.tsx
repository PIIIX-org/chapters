import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { TagInput } from './TagInput.js'

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The three standard keys a person may edit. `type` is immutable server-side
 *  and everything else is preserved OKF, shown but not touched. */
const EDITABLE = new Set(['resource', 'tags', 'timestamp'])

interface PropertyFieldsProps {
  frontmatter: Record<string, unknown>
  readOnly: boolean
  /** Called per keystroke, not debounced: both consumers write to a live store
   *  (the CRDT) or to nothing at all (the reader). */
  onSet: (key: string, value: string | string[]) => void
}

function PropertyFields({ frontmatter, readOnly, onSet }: PropertyFieldsProps) {
  const extraKeys = Object.entries(frontmatter).filter(
    ([key]) => key !== 'type' && !EDITABLE.has(key),
  )

  return (
    <dl className="grid grid-cols-[6rem_1fr] items-center gap-x-4 gap-y-2 text-sm">
      <dt className="font-medium text-muted-foreground">type</dt>
      <dd className="text-foreground">{asString(frontmatter.type) || '—'}</dd>

      {/* A <dl> may only contain dt/dd/div directly — a bare <label>/<input>
          pair in here is a definition-list violation, and axe says so. */}
      <dt>
        <Label htmlFor="pp-resource" className="text-muted-foreground">resource</Label>
      </dt>
      <dd>
        <Input
          id="pp-resource"
          value={asString(frontmatter.resource)}
          disabled={readOnly}
          onChange={(e) => onSet('resource', e.target.value)}
        />
      </dd>

      <dt className="font-medium text-muted-foreground">tags</dt>
      <dd>
        <TagInput
          value={asStringArray(frontmatter.tags)}
          onChange={(tags) => onSet('tags', tags)}
          disabled={readOnly}
        />
      </dd>

      <dt>
        <Label htmlFor="pp-timestamp" className="text-muted-foreground">timestamp</Label>
      </dt>
      <dd>
        <Input
          id="pp-timestamp"
          value={asString(frontmatter.timestamp)}
          disabled={readOnly}
          placeholder="ISO date (e.g. 2026-01-01)"
          onChange={(e) => onSet('timestamp', e.target.value)}
        />
      </dd>

      {extraKeys.map(([key, value]) => (
        <div key={key} className="col-span-2 flex gap-2">
          <dt className="font-medium text-muted-foreground">{key}:</dt>
          <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A plain snapshot of the Y.Map, refreshed on every change to it — local or
 * remote. `toJSON()` allocates, so it is called on the observer, not in render.
 */
function useFrontmatterSnapshot(frontmatter: Y.Map<unknown>): Record<string, unknown> {
  const [snapshot, setSnapshot] = useState<Record<string, unknown>>(() => frontmatter.toJSON())

  useEffect(() => {
    const read = () => setSnapshot(frontmatter.toJSON())
    // The relay seeds the map in `onLoadDocument`, which can land between this
    // render and the subscription below — read once more to catch that.
    read()
    frontmatter.observe(read)
    return () => frontmatter.unobserve(read)
  }, [frontmatter])

  return snapshot
}

interface CollabPropertyPanelProps {
  /** `ydoc.getMap('frontmatter')` — the shape the relay loads and stores. */
  frontmatter: Y.Map<unknown>
  /** `!session.writable` from `useCollabDoc`: revoked *or* offline. Never
   *  `status === 'revoked'` alone — that leaves the panel writable while
   *  nothing is syncing. */
  readOnly: boolean
}

/**
 * Editors: the note's frontmatter Y.Map is the store. There is no debounced
 * `PUT` here any more — a last-write-wins save racing the CRDT is issue #66
 * aimed at the engine that fixes it — and no local mirror of the values, so a
 * property another editor changes appears here as they type it.
 */
export function CollabPropertyPanel({ frontmatter, readOnly }: CollabPropertyPanelProps) {
  const snapshot = useFrontmatterSnapshot(frontmatter)

  function onSet(key: string, value: string | string[]) {
    if (readOnly) return
    // An emptied field is an absent key, not an empty string: the note's
    // frontmatter should not sprout `resource: ""` because someone cleared it.
    const empty = typeof value === 'string' ? value.trim() === '' : value.length === 0
    if (empty) frontmatter.delete(key)
    // ponytail: stored as typed, not trimmed — trimming per keystroke makes a
    // space unbannable to type. The server trims on write if it ever cares.
    else frontmatter.set(key, value)
  }

  return <PropertyFields frontmatter={snapshot} readOnly={readOnly} onSet={onSet} />
}

/**
 * Readers: whatever the SSE frame last said (`useLiveNote`). Locked, but not
 * frozen — the frames keep arriving as editors type, so this stays current
 * without the reader ever joining the Yjs document.
 */
export function LivePropertyPanel({ frontmatter }: { frontmatter: Record<string, unknown> }) {
  return <PropertyFields frontmatter={frontmatter} readOnly onSet={() => {}} />
}
