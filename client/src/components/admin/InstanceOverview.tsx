import { INSTANCE_BACKUP_URL } from '../../api/admin.js'
import { useAdminStats } from '../../hooks/useAdmin.js'
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="font-display text-2xl text-foreground">{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  )
}

export function InstanceOverview() {
  const stats = useAdminStats()

  const byStatus = new Map((stats.data?.usersByStatus ?? []).map((row) => [row.status, row.count]))

  return (
    <div className="flex flex-col gap-8">
      {stats.isPending ? (
        <p className="text-sm text-muted-foreground">Loading instance stats…</p>
      ) : stats.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {stats.error.message}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {/* Absent buckets are 0, not missing — the server only returns the
              statuses that have rows, so a fresh instance has no
              'deactivated' row at all. */}
          <Stat label="Awaiting approval" value={byStatus.get('pending_approval') ?? 0} />
          <Stat label="Active users" value={byStatus.get('active') ?? 0} />
          <Stat label="Deactivated" value={byStatus.get('deactivated') ?? 0} />
          <Stat label="Vaults" value={stats.data.vaults} />
          <Stat label="Teams" value={stats.data.teams} />
          <Stat label="Notes" value={stats.data.notes} />
          <Stat label="Stored" value={formatBytes(stats.data.storageBytes)} />
          <Stat label="Live MCP connections" value={stats.data.activeMcpConnections} />
        </div>
      )}

      <MfaRequirementToggle />

      <section className="flex flex-col gap-2">
        <h3 className="font-display text-lg text-foreground">Instance backup</h3>
        <p className="text-sm text-muted-foreground">
          Downloads every vault, note and share on this instance as a single zip. It contains everyone&rsquo;s
          notes in plain text, so treat the file the way you would treat the database itself.
        </p>
        <p className="text-sm text-muted-foreground">
          Restoring is deliberately not a button — run <code className="font-mono text-xs">pnpm restore-backup</code>{' '}
          against a stopped instance. Restoring over a live one is not something to do by accident.
        </p>
        {/* A zip, not JSON: a plain same-origin link carries the session cookie
            and streams straight to disk, where apiFetch would try to parse it. */}
        <a
          href={INSTANCE_BACKUP_URL}
          download
          className="w-fit rounded-lg bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/80"
        >
          Download backup
        </a>
      </section>
    </div>
  )
}
