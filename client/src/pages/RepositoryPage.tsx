import { useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  canShowInline,
  CodeViewer,
  type CodeViewerHandle,
} from '../components/repositories/CodeViewer.js'
import { ConnectRepositoryDialog } from '../components/repositories/ConnectRepositoryDialog.js'
import { RepositoryFileTree } from '../components/repositories/RepositoryFileTree.js'
import { RepositorySettingsDialog } from '../components/repositories/RepositorySettingsDialog.js'
import { RepositoryShareList } from '../components/repositories/RepositoryShareList.js'
import { RepositorySyncCard } from '../components/repositories/RepositorySyncCard.js'
import { SymbolOutline } from '../components/repositories/SymbolOutline.js'
import { SyncTokenList } from '../components/repositories/SyncTokenList.js'
import { WebhookSetupCard } from '../components/repositories/WebhookSetupCard.js'
import { ContextPanel, Inspector } from '../components/shell/ShellPanels.js'
import {
  useShellBreadcrumb,
  useShellStatus,
  type ShellStatus,
} from '../components/shell/shell-context.js'
import { Button } from '../components/ui/button.js'
import { PanelState } from '../components/ui/empty-state.js'
import { Eyebrow } from '../components/ui/eyebrow.js'
import { Pill } from '../components/ui/pill.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js'
import { syncHealth, type SyncHealth } from '../api/repositories.js'
import { useRepository, useRepositoryFile, useRepositoryFiles } from '../hooks/useRepositories.js'

/**
 * `/repos/:id/files/*` — the repository surface: directory tree in the
 * context panel, the code viewer (with its 40px file bar) in the content
 * cell, and the connection's detail in the inspector as Sync · Webhook ·
 * Access · Symbols tabs. The `/repos` index now exists and is the breadcrumb's
 * way back; connecting stays a dialog here too, over whatever is on screen.
 *
 * Everything on it is read-only, permanently: git stays the record of truth
 * (`2026-07-18-repository-ingestion-design.md`), so there is no edit path, no
 * autosave and nothing to revert.
 */

/** The page's sync health, published to the top bar's status pill. */
const SYNC_STATUS: Record<SyncHealth, ShellStatus> = {
  syncing: { tone: 'idle', label: 'Syncing' },
  error: { tone: 'error', label: 'Sync error' },
  'never-synced': { tone: 'neutral', label: 'Never synced' },
  'synced-empty': { tone: 'neutral', label: 'Synced · empty' },
  synced: { tone: 'live', label: 'Synced' },
}

export function RepositoryPage() {
  const { id } = useParams<{ id: string }>()
  // The splat is the file path, with its slashes intact. Empty at
  // `/repos/:id/files` — a real state (no file chosen yet), not a missing one.
  const path = useParams()['*'] ?? ''
  const navigate = useNavigate()
  const [connecting, setConnecting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tab, setTab] = useState('sync')
  const viewerRef = useRef<CodeViewerHandle>(null)
  const repository = useRepository(id!)
  const files = useRepositoryFiles(id!)

  // isError before .data, every time: a repository whose fetch failed must
  // never fall through to "that repository is not available to you", which
  // reads as a permissions answer to what is actually a broken request.
  const repo = repository.isError ? undefined : repository.data
  // An unreadable file list is unknown, not zero — `syncHealth` must not be
  // handed a `synced-empty` it would have invented.
  const fileCount = files.isError || files.isPending ? undefined : files.data.length
  useShellStatus(repo ? SYNC_STATUS[syncHealth(repo, fileCount)] : null)

  const connectDialog = (
    <ConnectRepositoryDialog
      open={connecting}
      onOpenChange={setConnecting}
      onConnected={(created) => navigate(`/repos/${created.id}/files`)}
    />
  )

  if (repository.isError) {
    return (
      <Shell connectDialog={connectDialog} onConnect={() => setConnecting(true)}>
        <PanelState
          status="error"
          title="We couldn’t load this repository."
          message={repository.error.message}
          onRetry={() => repository.refetch()}
        />
      </Shell>
    )
  }
  if (repository.isPending) {
    return (
      <Shell connectDialog={connectDialog} onConnect={() => setConnecting(true)}>
        <PanelState status="loading" message="Loading this repository…" />
      </Shell>
    )
  }

  if (!repo) {
    // Same answer the server gives by 404ing an unreachable id: gone and
    // never-shared are one state on purpose, so an id cannot be probed.
    return (
      <Shell connectDialog={connectDialog} onConnect={() => setConnecting(true)}>
        <PanelState
          status="empty"
          title="That repository isn’t available to you."
          message="It may have been deleted, or the share that reached it revoked."
        />
      </Shell>
    )
  }

  const openFile = files.isError || files.isPending ? undefined : files.data.find((f) => f.path === path)
  const oversize = openFile !== undefined && !canShowInline(openFile.size)
  // Owner-only, and git only: every control on the webhook card POSTs, a
  // viewer's POST is a 404 by design, and the other two ingestion methods
  // have no git host to configure. No tab rather than an empty one.
  const webhookTab = repo.access === 'owner' && repo.ingestionMethod === 'git'
  const activeTab = tab === 'webhook' && !webhookTab ? 'sync' : tab

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

      <ContextPanel label="Files">
        <div className="sticky top-0 z-10 flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <Eyebrow as="h2">Files</Eyebrow>
          {fileCount !== undefined && (
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">{fileCount}</span>
          )}
        </div>
        <div className="min-h-0 flex-1 p-2">
          {/* isError first here too — an unreadable list is not an empty one. */}
          {files.isError ? (
            <p role="alert" className="px-2 py-1 text-sm text-destructive">
              {files.error.message || 'Could not load this repository’s files.'}
            </p>
          ) : files.isPending ? (
            <PanelState status="loading" compact />
          ) : files.data.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Nothing is indexed yet. The sync panel says what this connection is waiting on.
            </p>
          ) : (
            <RepositoryFileTree repositoryId={repo.id} files={files.data} activePath={path} />
          )}
        </div>
      </ContextPanel>

      <div className="flex min-h-0 flex-1 flex-col">
        {path ? (
          // Keyed on the file: the viewer mounts one document per file and
          // has no cursor or history worth carrying across a switch.
          <CodeViewer key={path} ref={viewerRef} repository={repo} path={path} meta={openFile} />
        ) : (
          <PanelState
            status="empty"
            title="No file open"
            message="Pick a file to read it. Chapters never writes code back — git stays the record of truth."
          />
        )}
      </div>

      <Inspector label="Repository">
        <Tabs value={activeTab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="sticky top-0 z-10 bg-card">
            <TabsTrigger value="sync">Sync</TabsTrigger>
            {webhookTab && <TabsTrigger value="webhook">Webhook</TabsTrigger>}
            <TabsTrigger value="access">Access</TabsTrigger>
            <TabsTrigger value="symbols">Symbols</TabsTrigger>
          </TabsList>
          <TabsContent value="sync" className="p-3">
            <RepositorySyncCard repositoryId={repo.id} titleAs="h2" />
          </TabsContent>
          {webhookTab && (
            <TabsContent value="webhook" className="p-3">
              <WebhookSetupCard repository={repo} titleAs="h2" />
            </TabsContent>
          )}
          <TabsContent value="access" className="flex flex-col gap-3 p-3">
            {repo.access === 'owner' ? (
              <>
                {/* The settings dialog composes the same two components for
                    rename-adjacent housekeeping; access lives here day to day. */}
                <RepositoryShareList repositoryId={repo.id} titleAs="h2" />
                <SyncTokenList repositoryId={repo.id} titleAs="h2" />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Shared with you, read-only. Who can see this repository is its owner&rsquo;s call.
              </p>
            )}
          </TabsContent>
          <TabsContent value="symbols" className="p-3">
            <SymbolsPanel
              repositoryId={repo.id}
              path={path}
              oversize={oversize}
              onSelect={(line) => viewerRef.current?.revealLine(line)}
            />
          </TabsContent>
        </Tabs>
      </Inspector>
    </Shell>
  )
}

/**
 * The Symbols tab: the open file's outline, jumping the viewer beside it.
 * Reads the same query the viewer holds — deduplicated by key, so it costs no
 * second request — and refuses to render a jump list beside a file that is
 * not mounted (over the byte cap, failed, or absent), where every row would
 * jump nowhere.
 */
function SymbolsPanel({
  repositoryId,
  path,
  oversize,
  onSelect,
}: {
  repositoryId: string
  path: string
  /** Known from the file list before any fetch — don't start one just for an outline. */
  oversize: boolean
  onSelect: (startLine: number) => void
}) {
  const file = useRepositoryFile(repositoryId, path === '' || oversize ? null : path)

  if (path === '') {
    return (
      <PanelState
        compact
        status="empty"
        title="No file open"
        message="Open a file to see its outline."
      />
    )
  }
  if (oversize || (!file.isError && file.data && !canShowInline(file.data.size))) {
    return (
      <PanelState
        compact
        status="empty"
        title="No outline"
        message="This file is too large to show inline, so there is no editor for a symbol to jump in."
      />
    )
  }
  if (file.isError) {
    // The viewer beside this already announces the failure; a second alert
    // here would double-announce it.
    return (
      <PanelState
        compact
        status="empty"
        title="No outline"
        message="This file could not be read, so there is nothing to outline."
      />
    )
  }
  if (file.isPending) return <PanelState compact status="loading" />
  return <SymbolOutline symbols={file.data.symbols} onSelect={onSelect} />
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
  useShellBreadcrumb([{ label: 'Repositories', to: '/repos' }, { label: title ?? 'Repository' }])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="truncate text-sm font-medium text-foreground">{title ?? 'Repository'}</h1>
        {subtitle && <Pill>{subtitle}</Pill>}
        <div className="ml-auto flex items-center gap-2">
          {onSettings && (
            <Button type="button" variant="outline" size="sm" onClick={onSettings}>
              Settings
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={onConnect}>
            Connect a repository
          </Button>
        </div>
      </header>
      {children}
      {connectDialog}
    </div>
  )
}
