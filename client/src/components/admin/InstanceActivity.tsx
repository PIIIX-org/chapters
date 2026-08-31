import { useState } from 'react'
import { Button } from '../ui/button.js'
import { PanelState } from '../ui/empty-state.js'
import { Panel, PanelHeader } from '../ui/panel.js'
import { Pill, type PillTone } from '../ui/pill.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js'
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

function actorTone(actorType: string): PillTone {
  // The authorship rule: teal means AI/MCP touched it, the human accent means
  // a person did. Anything unrecognised stays neutral.
  if (actorType === 'mcp') return 'ai'
  if (actorType === 'user') return 'human'
  return 'neutral'
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
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`Newer ${label}`}
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
      >
        Newer
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
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
    <Panel>
      <PanelHeader
        title="Security events"
        actions={
          <Pager
            offset={offset}
            count={events.data?.length ?? 0}
            onChange={setOffset}
            label="security events"
          />
        }
      />
      {events.isPending ? (
        <PanelState status="loading" compact message="Loading events…" />
      ) : events.isError ? (
        <PanelState status="error" compact message={events.error.message} />
      ) : events.data.length === 0 ? (
        <PanelState status="empty" compact message="Nothing recorded on this page." />
      ) : (
        <Table>
          <caption className="sr-only">Security events on this instance</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Time</TableHead>
              <TableHead scope="col">Event</TableHead>
              <TableHead scope="col">IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.data.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="h-8 font-mono text-xs text-muted-foreground">
                  {formatStamp(event.createdAt)}
                </TableCell>
                <TableCell className="h-8 text-[13px] text-foreground">
                  {event.type.replace(/_/g, ' ')}
                </TableCell>
                <TableCell className="h-8 font-mono text-xs text-muted-foreground">
                  {event.ip ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}

function AuditTrail() {
  const [offset, setOffset] = useState(0)
  const entries = useAuditTrail(PAGE_SIZE, offset)

  return (
    <Panel>
      <PanelHeader
        title="Content audit trail"
        actions={
          <Pager
            offset={offset}
            count={entries.data?.length ?? 0}
            onChange={setOffset}
            label="audit entries"
          />
        }
      />
      {/* The spec's hard boundary, stated on screen so it reads as a promise
          rather than an omission someone might file as a missing feature. */}
      <p className="border-b border-border px-3 py-2 text-[13px] text-muted-foreground">
        Who changed which note, and when. Never what the change said — no
        admin, on any instance, can read a note they have not been given
        access to.
      </p>
      {entries.isPending ? (
        <PanelState status="loading" compact message="Loading the trail…" />
      ) : entries.isError ? (
        <PanelState status="error" compact message={entries.error.message} />
      ) : entries.data.length === 0 ? (
        <PanelState status="empty" compact message="Nothing recorded on this page." />
      ) : (
        <Table>
          <caption className="sr-only">
            Who changed which note, and when — never the change itself
          </caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Time</TableHead>
              <TableHead scope="col">Action</TableHead>
              <TableHead scope="col">Note</TableHead>
              <TableHead scope="col">Actor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.data.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="h-8 font-mono text-xs text-muted-foreground">
                  {formatStamp(entry.createdAt)}
                </TableCell>
                <TableCell className="h-8 text-[13px] text-foreground">
                  {entry.action}
                </TableCell>
                <TableCell className="h-8 font-mono text-xs text-muted-foreground">
                  {entry.notePath}
                </TableCell>
                <TableCell className="h-8">
                  <Pill tone={actorTone(entry.actorType)}>{entry.actorType}</Pill>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}

export function InstanceActivity() {
  return (
    <div className="flex flex-col gap-4">
      <SecurityEventLog />
      <AuditTrail />
    </div>
  )
}
