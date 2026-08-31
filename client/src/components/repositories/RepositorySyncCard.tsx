import type { ReactNode } from 'react'
import { syncHealth } from '../../api/repositories.js'
import type { AccessibleRepository, SyncHealth } from '../../api/repositories.js'
import { useRepository, useRepositoryFiles } from '../../hooks/useRepositories.js'
import { Panel, PanelBody, PanelHeader } from '../ui/panel.js'
import { StatusDot, type PillTone } from '../ui/pill.js'
import { cn } from '../../lib/utils.js'

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

const HEALTH_TONE: Record<SyncHealth, PillTone> = {
  syncing: 'idle',
  error: 'error',
  'never-synced': 'neutral',
  'synced-empty': 'neutral',
  synced: 'live',
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

interface RepositorySyncCardProps {
  repositoryId: string
  /** h3 inside a dialog that already has an h2 title; h2 in the inspector. */
  titleAs?: 'h2' | 'h3'
}

function Frame({ titleAs, children }: { titleAs: 'h2' | 'h3'; children: ReactNode }) {
  return (
    <Panel>
      <PanelHeader title="Sync" titleAs={titleAs} />
      <PanelBody className="flex flex-col gap-1.5">{children}</PanelBody>
    </Panel>
  )
}

/**
 * Sync health for one repository, in the five states `syncHealth` separates.
 * "Never synced" and "synced and empty" get different words because they need
 * different next actions, and a file list that failed to load reports itself
 * as unknown rather than as zero.
 */
export function RepositorySyncCard({ repositoryId, titleAs = 'h3' }: RepositorySyncCardProps) {
  const repository = useRepository(repositoryId)
  const files = useRepositoryFiles(repositoryId)

  // isError first, always: a repository whose fetch failed must never render
  // as "synced, 0 files".
  if (repository.isError) {
    return (
      <Frame titleAs={titleAs}>
        <p role="alert" className="text-sm text-destructive">
          {repository.error.message || 'Could not load this repository.'}
        </p>
      </Frame>
    )
  }
  if (repository.isPending) {
    return (
      <Frame titleAs={titleAs}>
        <p className="text-sm text-muted-foreground">Loading sync status…</p>
      </Frame>
    )
  }

  const repo = repository.data
  if (!repo) {
    return (
      <Frame titleAs={titleAs}>
        <p className="text-sm text-muted-foreground">That repository is not available to you.</p>
      </Frame>
    )
  }

  // An unreadable file list is not an empty one — leave `fileCount` undefined
  // so `syncHealth` reports `synced` instead of inventing `synced-empty`.
  const fileCount = files.isError || files.isPending ? undefined : files.data.length
  const health = syncHealth(repo, fileCount)

  return (
    <Frame titleAs={titleAs}>
      <p
        className={cn(
          'flex items-center gap-2 text-sm',
          health === 'error' ? 'text-destructive' : 'text-foreground',
        )}
      >
        <StatusDot tone={HEALTH_TONE[health]} />
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
    </Frame>
  )
}
