import { useState } from 'react'
import { Button } from '../ui/button.js'
import { useAuditTrail, useSecurityEvents } from '../../hooks/useAdmin.js'

const PAGE_SIZE = 50

const stamp = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function formatStamp(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : stamp.format(parsed)
}

/**
 * Both feeds are offset-paginated server-side and neither reports a total, so
 * "there is a next page" is inferred the only way it can be: a full page came
 * back. A short page is the last one.
 */
function Pager({
  offset,
  count,
  onChange,
  label,
}: {
  offset: number
  count: number
  onChange: (next: number) => void
  label: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={`Newer ${label}`}
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
      >
        Newer
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={`Older ${label}`}
        disabled={count < PAGE_SIZE}
        onClick={() => onChange(offset + PAGE_SIZE)}
      >
        Older
      </Button>
    </div>
  )
}

function SecurityEventLog() {
  const [offset, setOffset] = useState(0)
  const events = useSecurityEvents(PAGE_SIZE, offset)

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-lg text-foreground">Security events</h3>
        <Pager
          offset={offset}
          count={events.data?.length ?? 0}
          onChange={setOffset}
          label="security events"
        />
      </div>
      {events.isPending ? (
        <p className="text-sm text-muted-foreground">Loading events…</p>
      ) : events.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {events.error.message}
        </p>
      ) : events.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing recorded on this page.</p>
      ) : (
        <ul className="flex flex-col">
          {events.data.map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-border py-2">
              <span className="font-mono text-xs text-muted-foreground">{formatStamp(event.createdAt)}</span>
              <span className="text-sm text-foreground">{event.type.replace(/_/g, ' ')}</span>
              {event.ip && <span className="font-mono text-xs text-muted-foreground">{event.ip}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AuditTrail() {
  const [offset, setOffset] = useState(0)
  const entries = useAuditTrail(PAGE_SIZE, offset)

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-lg text-foreground">Content audit trail</h3>
        <Pager offset={offset} count={entries.data?.length ?? 0} onChange={setOffset} label="audit entries" />
      </div>
      {/* The spec's hard boundary, stated on screen so it reads as a promise
          rather than an omission someone might file as a missing feature. */}
      <p className="text-sm text-muted-foreground">
        Who changed which note, and when. Never what the change said — no admin, on any instance, can read a note
        they have not been given access to.
      </p>
      {entries.isPending ? (
        <p className="text-sm text-muted-foreground">Loading the trail…</p>
      ) : entries.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {entries.error.message}
        </p>
      ) : entries.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing recorded on this page.</p>
      ) : (
        <ul className="flex flex-col">
          {entries.data.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-border py-2">
              <span className="font-mono text-xs text-muted-foreground">{formatStamp(entry.createdAt)}</span>
              <span className="text-sm text-foreground">{entry.action}</span>
              <span className="font-mono text-xs text-muted-foreground">{entry.notePath}</span>
              <span className="text-xs text-muted-foreground">by {entry.actorType}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function InstanceActivity() {
  return (
    <div className="flex flex-col gap-8">
      <SecurityEventLog />
      <AuditTrail />
    </div>
  )
}
