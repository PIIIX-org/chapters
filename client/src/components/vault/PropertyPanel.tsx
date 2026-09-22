import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { AlertCircle, Cpu, Shield } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { TagInput } from './TagInput.js'

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function isValidIso(val: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(val) &&
    !isNaN(Date.parse(val))
  )
}

const FIRST_CLASS_KEYS = new Set([
  'type',
  'resource',
  'tags',
  'timestamp',
  'status',
  'verified',
  'generated',
  'sources',
])

/** The inspector's field-name column: mono eyebrow, like every machine label
 *  in the console. Applied to Label too — `cn` merges the size override in. */
const KEY = 'font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground'

function getStatusBadgeClass(status: string): string {
  switch (status.toLowerCase()) {
    case 'active':
    case 'stable':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    case 'draft':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
    case 'deprecated':
    case 'superseded':
    case 'archived':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
    default:
      return 'border-border bg-muted text-muted-foreground'
  }
}

function getStatusDotColor(status: string): string {
  switch (status.toLowerCase()) {
    case 'active':
    case 'stable':
      return 'bg-emerald-500'
    case 'draft':
      return 'bg-amber-500'
    case 'deprecated':
    case 'superseded':
    case 'archived':
      return 'bg-rose-500'
    default:
      return 'bg-muted-foreground'
  }
}

interface VerifiedItem {
  tier: string
  by?: string
  at?: string
}

function parseVerified(val: unknown): VerifiedItem[] {
  if (!val) return []
  if (Array.isArray(val)) {
    return val
      .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
      .map((v) => ({
        tier: String(v.tier || ''),
        by: typeof v.by === 'string' ? v.by : undefined,
        at: typeof v.at === 'string' ? v.at : undefined,
      }))
      .filter((v) => v.tier.length > 0)
  }
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, unknown>
    if (typeof obj.tier === 'string' && obj.tier.length > 0) {
      return [
        {
          tier: obj.tier,
          by: typeof obj.by === 'string' ? obj.by : undefined,
          at: typeof obj.at === 'string' ? obj.at : undefined,
        },
      ]
    }
  }
  return []
}

interface SourceItem {
  resource: string
  title?: string
  last_modified?: string
}

function parseSources(val: unknown): SourceItem[] {
  if (!Array.isArray(val)) return []
  return val
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({
      resource: asString(v.resource),
      title: typeof v.title === 'string' ? v.title : undefined,
      last_modified: typeof v.last_modified === 'string' ? v.last_modified : undefined,
    }))
    .filter((s) => s.resource.length > 0 || Boolean(s.title))
}

interface PropertyFieldsProps {
  frontmatter: Record<string, unknown>
  readOnly: boolean
  /** Called per keystroke, not debounced: both consumers write to a live store
   *  (the CRDT) or to nothing at all (the reader). */
  onSet: (key: string, value: string | string[]) => void
}

function PropertyFields({ frontmatter, readOnly, onSet }: PropertyFieldsProps) {
  const extraKeys = Object.entries(frontmatter).filter(
    ([key]) => !FIRST_CLASS_KEYS.has(key),
  )

  const timestampVal = asString(frontmatter.timestamp)
  const isTimestampInvalid = timestampVal.trim() !== '' && !isValidIso(timestampVal)

  const statusVal = asString(frontmatter.status)
  const verifiedList = parseVerified(frontmatter.verified)

  const generated =
    typeof frontmatter.generated === 'object' && frontmatter.generated !== null
      ? (frontmatter.generated as Record<string, unknown>)
      : null
  const genBy = generated ? asString(generated.by) : ''
  const genAt = generated ? asString(generated.at) : ''

  const sourcesList = parseSources(frontmatter.sources)

  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
      <dt className={KEY}>type</dt>
      <dd className="font-mono text-xs text-foreground">{asString(frontmatter.type) || '—'}</dd>

      {/* A <dl> may only contain dt/dd/div directly — a bare <label>/<input>
          pair in here is a definition-list violation, and axe says so. */}
      <dt>
        <Label htmlFor="pp-resource" className={KEY}>resource</Label>
      </dt>
      <dd>
        <Input
          id="pp-resource"
          className="h-7 font-mono text-xs"
          value={asString(frontmatter.resource)}
          disabled={readOnly}
          onChange={(e) => onSet('resource', e.target.value)}
        />
      </dd>

      <dt className={KEY}>tags</dt>
      <dd>
        <TagInput
          value={asStringArray(frontmatter.tags)}
          onChange={(tags) => onSet('tags', tags)}
          disabled={readOnly}
        />
      </dd>

      <dt>
        <Label htmlFor="pp-timestamp" className={KEY}>timestamp</Label>
      </dt>
      <dd className="flex items-center gap-1.5">
        <Input
          id="pp-timestamp"
          className={cn(
            'h-7 font-mono text-xs tabular-nums',
            isTimestampInvalid && 'border-destructive/60 focus-visible:ring-destructive',
          )}
          value={timestampVal}
          disabled={readOnly}
          placeholder="ISO date (e.g. 2026-01-01T00:00:00Z)"
          onChange={(e) => onSet('timestamp', e.target.value)}
        />
        <button
          type="button"
          disabled={readOnly}
          onClick={() => onSet('timestamp', new Date().toISOString())}
          className="inline-flex h-7 shrink-0 items-center justify-center rounded-sm border border-border bg-muted/50 px-2 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          NOW
        </button>
      </dd>

      {statusVal && (
        <>
          <dt className={KEY}>status</dt>
          <dd>
            <span
              data-slot="status-pill"
              className={cn(
                'inline-flex h-5 items-center gap-1.5 rounded-sm border px-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]',
                getStatusBadgeClass(statusVal),
              )}
            >
              <span
                aria-hidden="true"
                className={cn('size-1.5 shrink-0 rounded-full', getStatusDotColor(statusVal))}
              />
              {statusVal}
            </span>
          </dd>
        </>
      )}

      {verifiedList.length > 0 && (
        <>
          <dt className={KEY}>verified</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            {verifiedList.map((item, idx) => {
              if (item.tier === 'human-reviewed') {
                return (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                  >
                    <Shield className="size-3 shrink-0" aria-hidden="true" />
                    <span>human-reviewed{item.by ? ` by ${item.by}` : ''}</span>
                  </span>
                )
              }
              if (item.tier === 'machine-confirmed') {
                return (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 rounded-sm border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-sky-600 dark:text-sky-400"
                  >
                    <Cpu className="size-3 shrink-0" aria-hidden="true" />
                    <span>machine-confirmed{item.by ? ` by ${item.by}` : ''}</span>
                  </span>
                )
              }
              if (item.tier === 'unverified') {
                return (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-amber-600 dark:text-amber-400"
                  >
                    <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                    <span>unverified</span>
                  </span>
                )
              }
              return (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground"
                >
                  <span>{item.tier}{item.by ? ` by ${item.by}` : ''}</span>
                </span>
              )
            })}
          </dd>
        </>
      )}

      {generated && (
        <>
          <dt className={KEY}>generated</dt>
          <dd className="flex flex-wrap items-baseline gap-1.5 font-mono text-xs text-foreground">
            {genBy && <span>{genBy}</span>}
            {genBy && genAt && <span className="text-muted-foreground">·</span>}
            {genAt && <span className="tabular-nums text-muted-foreground">{genAt}</span>}
            {!genBy && !genAt && <span>{JSON.stringify(generated)}</span>}
          </dd>
        </>
      )}

      {sourcesList.length > 0 && (
        <>
          <dt className={cn(KEY, 'self-start pt-1')}>sources</dt>
          <dd className="min-w-0">
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {sourcesList.map((src, i) => {
                const isHttp = /^https?:\/\//i.test(src.resource)
                return (
                  <li key={i} className="flex flex-col gap-0.5">
                    <div className="flex flex-wrap items-baseline gap-1.5">
                      {src.title && <span className="text-xs font-medium text-foreground">{src.title}</span>}
                      {src.resource && (
                        isHttp ? (
                          <a
                            href={src.resource}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="max-w-full truncate font-mono text-xs text-primary underline underline-offset-2 hover:text-primary/80"
                          >
                            {src.resource}
                          </a>
                        ) : (
                          <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground">
                            {src.resource}
                          </code>
                        )
                      )}
                    </div>
                    {src.last_modified && (
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                        {src.last_modified}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </dd>
        </>
      )}

      {extraKeys.map(([key, value]) => (
        <div key={key} className="col-span-2 flex min-w-0 items-baseline gap-2">
          <dt className={KEY}>{key}:</dt>
          <dd className="min-w-0 truncate font-mono text-xs tabular-nums text-foreground">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </dd>
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
