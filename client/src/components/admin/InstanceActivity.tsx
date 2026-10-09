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
        className="rounded-[var(--radius-sm,2px)]"
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
        className="rounded-[var(--radius-sm,2px)]"
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
    <Panel className="rounded-[var(--radius-md,4px)]">
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
        <Table className="rounded-[var(--radius-md,4px)]">
          <caption className="sr-only">Security events on this instance</caption>
          <TableHeader className="hidden sm:table-header-group">
            <TableRow>
              <TableHead scope="col">Time</TableHead>
              <TableHead scope="col">Event</TableHead>
              <TableHead scope="col">IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="block sm:table-row-group divide-y divide-border sm:divide-y-0">
            {events.data.map((event) => (
              <TableRow
                key={event.id}
                className="block sm:table-row p-3 sm:p-0 space-y-1 sm:space-y-0 align-top"
              >
                <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2 sm:h-8 font-mono text-xs tabular-nums text-muted-foreground h-auto">
                  {formatStamp(event.createdAt)}
                </TableCell>
                <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2 sm:h-8 text-[13px] font-medium sm:font-normal text-foreground h-auto">
                  {event.type.replace(/_/g, ' ')}
                </TableCell>
                <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2 sm:h-8 font-mono text-xs tabular-nums text-muted-foreground h-auto">
                  <span className="sm:hidden font-mono text-muted-foreground/70">IP: </span>
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
    <Panel className="rounded-[var(--radius-md,4px)]">
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
        <Table className="rounded-[var(--radius-md,4px)]">
          <caption className="sr-only">
            Who changed which note, and when — never the change itself
          </caption>
          <TableHeader className="hidden sm:table-header-group">
            <TableRow>
              <TableHead scope="col">Time</TableHead>
              <TableHead scope="col">Action</TableHead>
              <TableHead scope="col">Note</TableHead>
              <TableHead scope="col">Actor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="block sm:table-row-group divide-y divide-border sm:divide-y-0">
            {entries.data.map((entry) => (
              <TableRow
                key={entry.id}
                className="block sm:table-row p-3 sm:p-0 space-y-1.5 sm:space-y-0 align-top"
              >
                <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2 sm:h-8 font-mono text-xs tabular-nums text-muted-foreground h-auto">
                  {formatStamp(entry.createdAt)}
                </TableCell>
                <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2 sm:h-8 text-[13px] font-medium sm:font-normal text-foreground h-auto">
                  {entry.action}
                </TableCell>
                <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2 sm:h-8 font-mono text-xs text-muted-foreground h-auto whitespace-normal break-all">
                  <span className="sm:hidden font-mono text-muted-foreground/70">Note: </span>
                  {entry.notePath}
                </TableCell>
                <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2 sm:h-8 h-auto">
                  <Pill tone={actorTone(entry.actorType)} className="rounded-[var(--radius-sm,2px)] font-mono text-[11px]">{entry.actorType}</Pill>
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
