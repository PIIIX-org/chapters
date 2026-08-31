import { INSTANCE_BACKUP_URL } from '../../api/admin.js'
import { useAdminStats } from '../../hooks/useAdmin.js'
import { Button } from '../ui/button.js'
import { PanelState } from '../ui/empty-state.js'
import { Panel, PanelBody, PanelHeader } from '../ui/panel.js'
import { StatTile } from '../ui/stat-tile.js'
import { MfaRequirementToggle } from './MfaRequirementToggle.js'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function InstanceOverview() {
  const stats = useAdminStats()

  const byStatus = new Map(
    (stats.data?.usersByStatus ?? []).map((row) => [row.status, row.count]),
  )

  return (
    <div className="flex flex-col gap-4">
      {stats.isPending ? (
        <PanelState status="loading" message="Loading instance stats…" />
      ) : stats.isError ? (
        <PanelState status="error" message={stats.error.message} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {/* Absent buckets are 0, not missing — the server only returns the
              statuses that have rows, so a fresh instance has no
              'deactivated' row at all. */}
          <StatTile
            label="Awaiting approval"
            value={byStatus.get('pending_approval') ?? 0}
          />
          <StatTile label="Active users" value={byStatus.get('active') ?? 0} />
          <StatTile label="Deactivated" value={byStatus.get('deactivated') ?? 0} />
          <StatTile label="Vaults" value={stats.data.vaults} />
          <StatTile label="Teams" value={stats.data.teams} />
          <StatTile label="Notes" value={stats.data.notes} />
          <StatTile label="Stored" value={formatBytes(stats.data.storageBytes)} />
          <StatTile
            label="Live MCP connections"
            value={stats.data.activeMcpConnections}
          />
        </div>
      )}

      <MfaRequirementToggle />

      <Panel>
        <PanelHeader title="Instance backup" />
        <PanelBody className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">
            Downloads every vault, note and share on this instance as a single
            zip. It contains everyone&rsquo;s notes in plain text, so treat the
            file the way you would treat the database itself.
          </p>
          <p className="text-sm text-muted-foreground">
            Restoring is deliberately not a button — run{' '}
            <code className="font-mono text-xs">pnpm restore-backup</code>{' '}
            against a stopped instance. Restoring over a live one is not
            something to do by accident.
          </p>
          {/* A zip, not JSON: a plain same-origin link carries the session
              cookie and streams straight to disk, where apiFetch would try to
              parse it. */}
          <Button asChild size="sm" variant="outline">
            <a href={INSTANCE_BACKUP_URL} download>
              Download backup
            </a>
          </Button>
        </PanelBody>
      </Panel>
    </div>
  )
}
