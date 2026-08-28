import { syncHealth } from '../../api/repositories.js'
import type { AccessibleRepository, SyncHealth } from '../../api/repositories.js'
import { useRepository, useRepositoryFiles } from '../../hooks/useRepositories.js'

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString()
}

/**
 * What "nothing has been indexed" means next depends on where the code was
 * supposed to come from, and each line here is checked against what the server
 * actually runs — a card that promises an ingestion nobody implemented is
 * worse than one that admits there is none.
 *
 * git: the poller (`server/src/repositories/scheduler.ts`) selects git rows on
 * every tick and clones them, so this one really is "nothing to do".
 * local_path: nothing does. `startWatching` has no caller in `server/src`, the
 * poller filters to `ingestionMethod = 'git'`, and there is no manual sync
 * route — so a connected folder is never read.
 * agent_push: `POST /repositories/sync` exists and is registered, so an agent
 * holding a sync token can push; nothing else will.
 */
const NEVER_SYNCED_NEXT: Record<AccessibleRepository['ingestionMethod'], string> = {
  git: 'The first clone runs on the next poll after connecting. Nothing to do.',
  local_path:
    'Chapters does not read connected folders yet — no watcher runs and the poller skips them — so nothing will be indexed here.',
  agent_push: 'Nothing arrives until an agent holding a sync token pushes this repository.',
}

function headline(health: SyncHealth, fileCount: number | undefined): string {
  switch (health) {
    case 'syncing':
      return 'Syncing now'
    case 'error':
      return 'Last sync failed'
    case 'never-synced':
      return 'Never synced'
    case 'synced-empty':
      return 'Synced, but nothing was indexed'
    case 'synced':
      return fileCount === undefined ? 'Synced' : `Synced — ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`
  }
}

/**
 * Sync health for one repository, in the five states `syncHealth` separates.
 * "Never synced" and "synced and empty" get different words because they need
 * different next actions, and a file list that failed to load reports itself
 * as unknown rather than as zero.
 */
export function RepositorySyncCard({ repositoryId }: { repositoryId: string }) {
  const repository = useRepository(repositoryId)
  const files = useRepositoryFiles(repositoryId)

  // isError first, always: a repository whose fetch failed must never render
  // as "synced, 0 files".
  if (repository.isError) {
    return (
      <section className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3">
        <h3 className="font-display text-base text-foreground">Sync</h3>
        <p role="alert" className="text-sm text-destructive">
          {repository.error.message || 'Could not load this repository.'}
        </p>
      </section>
    )
  }
  if (repository.isPending) {
    return <p className="text-sm text-muted-foreground">Loading sync status…</p>
  }

  const repo = repository.data
  if (!repo) {
    return <p className="text-sm text-muted-foreground">That repository is not available to you.</p>
  }

  // An unreadable file list is not an empty one — leave `fileCount` undefined
  // so `syncHealth` reports `synced` instead of inventing `synced-empty`.
  const fileCount = files.isError || files.isPending ? undefined : files.data.length
  const health = syncHealth(repo, fileCount)

  return (
    <section className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3">
      <h3 className="font-display text-base text-foreground">Sync</h3>
      <p className={health === 'error' ? 'text-sm text-destructive' : 'text-sm text-foreground'}>
        {headline(health, fileCount)}
      </p>

      {health === 'syncing' && (
        <p className="text-xs text-muted-foreground">Chapters is indexing this repository right now.</p>
      )}

      {health === 'error' && (
        <p className="font-mono text-xs text-muted-foreground">
          {repo.lastSyncError ?? 'The server did not record a reason.'}
        </p>
      )}

      {health === 'never-synced' && (
        <p className="text-xs text-muted-foreground">{NEVER_SYNCED_NEXT[repo.ingestionMethod]}</p>
      )}

      {health === 'synced-empty' && (
        <p className="text-xs text-muted-foreground">
          A sync completed and found no files to index — check the path, the branch, and whether everything
          in it is ignored.
        </p>
      )}

      {repo.lastSyncedAt && (
        <p className="font-mono text-xs text-muted-foreground">Last synced {formatTimestamp(repo.lastSyncedAt)}</p>
      )}

      {files.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not count the indexed files.
        </p>
      )}

      {/* Git only: the other two methods have no webhook to deliver anything. */}
      {repo.ingestionMethod === 'git' &&
        (repo.lastWebhookAt ? (
          <p className="font-mono text-xs text-muted-foreground">
            Webhook delivering — last push received {formatTimestamp(repo.lastWebhookAt)}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No webhook deliveries yet — Chapters is polling this remote on a schedule instead, so changes
            take minutes to appear.
          </p>
        ))}
    </section>
  )
}
