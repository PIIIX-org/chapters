import { INSTANCE_BACKUP_URL } from '../../api/admin.js'
import { useAdminStats, useBackupStatus, useRunBackup } from '../../hooks/useAdmin.js'
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
  const backup = useBackupStatus()
  const runBackup = useRunBackup()

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
            className="rounded-[var(--radius-md,4px)]"
          />
          <StatTile
            label="Active users"
            value={byStatus.get('active') ?? 0}
            className="rounded-[var(--radius-md,4px)]"
          />
          <StatTile
            label="Deactivated"
            value={byStatus.get('deactivated') ?? 0}
            className="rounded-[var(--radius-md,4px)]"
          />
          <StatTile
            label="Vaults"
            value={stats.data.vaults}
            className="rounded-[var(--radius-md,4px)]"
          />
          <StatTile
            label="Teams"
            value={stats.data.teams}
            className="rounded-[var(--radius-md,4px)]"
          />
          <StatTile
            label="Notes"
            value={stats.data.notes}
            className="rounded-[var(--radius-md,4px)]"
          />
          <StatTile
            label="Stored"
            value={formatBytes(stats.data.storageBytes)}
            className="rounded-[var(--radius-md,4px)]"
          />
          <StatTile
            label="Live MCP connections"
            value={stats.data.activeMcpConnections}
            className="rounded-[var(--radius-md,4px)]"
          />
        </div>
      )}

      <MfaRequirementToggle />

      <Panel className="rounded-[var(--radius-md,4px)]">
        <PanelHeader title="Instance backup" />
        <PanelBody className="flex flex-col items-start gap-4">
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

          <div className="w-full rounded-[var(--radius-md,4px)] border border-border/60 bg-muted/30 p-3 text-sm">
            <div className="flex items-center justify-between pb-2">
              <span className="font-medium text-foreground">Automated offsite backups</span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  backup.data?.configured
                    ? backup.data.lastStatus === 'error'
                      ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                      : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {backup.data?.configured
                  ? backup.data.lastStatus === 'error'
                    ? 'Sync Error'
                    : 'Configured'
                  : 'Not configured'}
              </span>
            </div>

            {backup.data?.configured ? (
              <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {backup.data.localPath && (
                    <span>
                      <strong className="text-foreground">Local:</strong> {backup.data.localPath}
                    </span>
                  )}
                  {backup.data.s3Bucket && (
                    <span>
                      <strong className="text-foreground">S3:</strong> {backup.data.s3Bucket} ({backup.data.s3Prefix ?? 'elara-backups/'})
                    </span>
                  )}
                  <span>
                    <strong className="text-foreground">Schedule:</strong> every {backup.data.intervalHours}h (retention: last {backup.data.retentionCount})
                  </span>
                </div>
                {backup.data.lastRunAt && (
                  <div className="pt-1">
                    Last backup: {new Date(backup.data.lastRunAt).toLocaleString()}
                    {backup.data.lastSizeBytes ? ` (${formatBytes(backup.data.lastSizeBytes)})` : ''}
                    {backup.data.lastFilename ? ` — ${backup.data.lastFilename}` : ''}
                  </div>
                )}
                {backup.data.lastError && (
                  <div className="rounded bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">
                    {backup.data.lastError}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Configure <code className="font-mono text-[11px]">BACKUP_LOCAL_PATH</code> or{' '}
                <code className="font-mono text-[11px]">BACKUP_S3_BUCKET</code> in server environment variables to automate offsite snapshots.
              </p>
            )}

            {runBackup.isError && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                {runBackup.error.message}
              </p>
            )}
            {runBackup.isSuccess && (
              <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                Backup snapshot created successfully ({formatBytes(runBackup.data.result.sizeBytes)}).
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* A zip, not JSON: a plain same-origin link carries the session
                cookie and streams straight to disk, where apiFetch would try to
                parse it. */}
            <Button asChild size="sm" variant="outline" className="rounded-[var(--radius-md,4px)]">
              <a href={INSTANCE_BACKUP_URL} download>
                Download backup
              </a>
            </Button>
            {backup.data?.configured && (
              <Button
                size="sm"
                variant="secondary"
                className="rounded-[var(--radius-md,4px)]"
                disabled={runBackup.isPending}
                onClick={() => runBackup.mutate()}
              >
                {runBackup.isPending ? 'Backing up…' : 'Run backup now'}
              </Button>
            )}
          </div>
        </PanelBody>
      </Panel>
    </div>
  )
}

