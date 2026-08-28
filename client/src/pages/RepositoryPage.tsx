import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { CodeViewer } from '../components/repositories/CodeViewer.js'
import { ConnectRepositoryDialog } from '../components/repositories/ConnectRepositoryDialog.js'
import { RepositorySettingsDialog } from '../components/repositories/RepositorySettingsDialog.js'
import { RepositorySyncCard } from '../components/repositories/RepositorySyncCard.js'
import { WebhookSetupCard } from '../components/repositories/WebhookSetupCard.js'
import { Button } from '../components/ui/button.js'
import { useRepository, useRepositoryFiles } from '../hooks/useRepositories.js'
import { cn } from '../lib/utils.js'

/**
 * `/repos/:id/files/*` — the one repository surface there is. Per the shell
 * design there is deliberately no `/repos` index: repositories are reached
 * from ⌘K, and connecting one is a modal over whatever is already on screen,
 * which is why the connect dialog is hosted here rather than on a page of its
 * own.
 *
 * Everything on it is read-only, permanently: git stays the record of truth
 * (`2026-07-18-repository-ingestion-design.md`), so there is no edit path, no
 * autosave and nothing to revert.
 */
export function RepositoryPage() {
  const { id } = useParams<{ id: string }>()
  // The splat is the file path, with its slashes intact. Empty at
  // `/repos/:id/files` — a real state (no file chosen yet), not a missing one.
  const path = useParams()['*'] ?? ''
  const navigate = useNavigate()
  const [connecting, setConnecting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const repository = useRepository(id!)
  const files = useRepositoryFiles(id!)

  const connectDialog = (
    <ConnectRepositoryDialog
      open={connecting}
      onOpenChange={setConnecting}
      onConnected={(created) => navigate(`/repos/${created.id}/files`)}
    />
  )

  // isError before .data, every time: a repository whose fetch failed must
  // never fall through to "that repository is not available to you", which
  // reads as a permissions answer to what is actually a broken request.
  if (repository.isError) {
    return (
      <Shell connectDialog={connectDialog} onConnect={() => setConnecting(true)}>
        <div role="alert" className="flex flex-col items-start gap-3 p-8">
          <h2 className="font-display text-2xl text-foreground">We couldn&rsquo;t load this repository.</h2>
          <p className="text-sm text-muted-foreground">{repository.error.message}</p>
          <Button type="button" onClick={() => repository.refetch()}>
            Retry
          </Button>
        </div>
      </Shell>
    )
  }
  if (repository.isPending) {
    return (
      <Shell connectDialog={connectDialog} onConnect={() => setConnecting(true)}>
        <p className="p-8 text-sm text-muted-foreground">Loading this repository…</p>
      </Shell>
    )
  }

  const repo = repository.data
  if (!repo) {
    // Same answer the server gives by 404ing an unreachable id: gone and
    // never-shared are one state on purpose, so an id cannot be probed.
    return (
      <Shell connectDialog={connectDialog} onConnect={() => setConnecting(true)}>
        <div className="flex flex-col items-start gap-3 p-8">
          <h2 className="font-display text-2xl text-foreground">That repository isn&rsquo;t available to you.</h2>
          <p className="text-sm text-muted-foreground">
            It may have been deleted, or the share that reached it revoked.
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell
      connectDialog={connectDialog}
      onConnect={() => setConnecting(true)}
      title={repo.name}
      subtitle={repo.access === 'owner' ? undefined : 'Shared with you'}
      onSettings={repo.access === 'owner' ? () => setSettingsOpen(true) : undefined}
    >
      {/* Mounted only while open, so each open reads the current name and
          mergeable value instead of a stale copy from the last time. */}
      {repo.access === 'owner' && settingsOpen && (
        <RepositorySettingsDialog
          repository={repo}
          open
          onOpenChange={setSettingsOpen}
          // The route it was open over no longer resolves — anywhere else is
          // better than a "not available to you" page for a repository this
          // person just deleted on purpose.
          onDeleted={() => navigate('/')}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Files" className="flex w-64 shrink-0 flex-col gap-2 overflow-auto border-r border-border p-3">
          <h2 className="font-display text-sm text-foreground">Files</h2>
          {/* isError first here too — an unreadable list is not an empty one. */}
          {files.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {files.error.message || 'Could not load this repository’s files.'}
            </p>
          ) : files.isPending ? (
            <p className="text-sm text-muted-foreground">Loading files…</p>
          ) : files.data.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing is indexed yet. The sync panel says what this connection is waiting on.
            </p>
          ) : (
            /* ponytail: a flat, sorted path list, not a collapsible tree.
               `RepositoryFileTree` (plan task 4) is not built; when it lands it
               drops in here and takes the same `files.data`. */
            <ul className="flex flex-col">
              {[...files.data]
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((file) => (
                  <li key={file.id}>
                    <Link
                      to={`/repos/${repo.id}/files/${file.path}`}
                      aria-current={file.path === path ? 'page' : undefined}
                      className={cn(
                        'block truncate rounded-md px-2 py-1 font-mono text-xs text-foreground hover:bg-muted',
                        file.path === path && 'bg-muted',
                      )}
                    >
                      {file.path}
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </aside>

        <div className="min-w-0 flex-1">
          {path ? (
            // Keyed on the file: the viewer mounts one document per file and
            // has no cursor or history worth carrying across a switch.
            <CodeViewer key={path} repository={repo} path={path} />
          ) : (
            <p className="p-8 text-sm text-muted-foreground">
              Pick a file to read it. Chapters never writes code back — git stays the record of truth.
            </p>
          )}
        </div>

        <aside aria-label="Connection" className="flex w-72 shrink-0 flex-col gap-3 overflow-auto border-l border-border p-3">
          <RepositorySyncCard repositoryId={repo.id} />
          {/* Owner-only: every control on it POSTs, and a viewer's POST is a
              404 by design. A disabled card would advertise a door that isn't
              theirs. */}
          {repo.access === 'owner' && <WebhookSetupCard repository={repo} />}
        </aside>
      </div>
    </Shell>
  )
}

interface ShellProps {
  children: React.ReactNode
  connectDialog: React.ReactNode
  onConnect: () => void
  title?: string
  subtitle?: string
  /** Owner-only: undefined for a viewer, whose every settings call would 404. */
  onSettings?: () => void
}

function Shell({ children, connectDialog, onConnect, title, subtitle, onSettings }: ShellProps) {
  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Link to="/" className="text-sm text-muted-foreground underline">
          ← Home
        </Link>
        <h1 className="font-display text-lg text-foreground">{title ?? 'Repository'}</h1>
        {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
        <div className="ml-auto flex items-center gap-2">
          {onSettings && (
            <Button type="button" variant="secondary" size="sm" onClick={onSettings}>
              Settings
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={onConnect}>
            Connect a repository
          </Button>
        </div>
      </header>
      {children}
      {connectDialog}
    </div>
  )
}
