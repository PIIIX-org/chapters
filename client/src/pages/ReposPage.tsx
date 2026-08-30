import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Plus } from 'lucide-react'
import { ConnectRepositoryDialog } from '../components/repositories/ConnectRepositoryDialog.js'
import { Button } from '../components/ui/button.js'
import { PanelState } from '../components/ui/empty-state.js'
import { Panel, PanelHeader } from '../components/ui/panel.js'
import { Pill, type PillTone } from '../components/ui/pill.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js'
import { useShellBreadcrumb } from '../components/shell/shell-context.js'
import { useRepositories } from '../hooks/useRepositories.js'
import {
  syncHealth,
  type IngestionMethod,
  type SyncHealth,
} from '../api/repositories.js'

const METHOD_LABEL: Record<IngestionMethod, string> = {
  git: 'Git',
  local_path: 'Local folder',
  agent_push: 'Agent push',
}

const HEALTH: Record<SyncHealth, { tone: PillTone; label: string }> = {
  syncing: { tone: 'idle', label: 'Syncing' },
  error: { tone: 'error', label: 'Sync error' },
  'never-synced': { tone: 'neutral', label: 'Never synced' },
  'synced-empty': { tone: 'neutral', label: 'Synced · empty' },
  synced: { tone: 'live', label: 'Synced' },
}

const syncedFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** `/repos` — what the rail's Repositories item lands on; connect lives here too. */
export function ReposPage() {
  const repositories = useRepositories()
  const navigate = useNavigate()
  const [connecting, setConnecting] = useState(false)
  useShellBreadcrumb([{ label: 'Repositories' }])

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-5">
        <Panel>
          <PanelHeader
            title="Repositories"
            actions={
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConnecting(true)}
              >
                <Plus aria-hidden="true" />
                Connect a repository
              </Button>
            }
          />
          {repositories.isError ? (
            <PanelState
              status="error"
              title="We couldn’t load your repositories."
              message={repositories.error.message}
              onRetry={() => repositories.refetch()}
            />
          ) : repositories.isPending ? (
            <PanelState status="loading" />
          ) : repositories.data.length === 0 ? (
            <PanelState
              status="empty"
              title="No repositories yet"
              message="Connect one and its files join the graph beside your notes. Chapters never writes code back — git stays the record of truth."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Sync</TableHead>
                  <TableHead>Last synced</TableHead>
                  <TableHead>Access</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repositories.data.map((repo) => {
                  const health = HEALTH[syncHealth(repo)]
                  return (
                    <TableRow key={repo.id}>
                      <TableCell>
                        <Link
                          to={`/repos/${repo.id}/files`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {repo.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {METHOD_LABEL[repo.ingestionMethod]}
                      </TableCell>
                      <TableCell>
                        <Pill tone={health.tone} dot>
                          {health.label}
                        </Pill>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {repo.lastSyncedAt
                          ? syncedFormatter.format(new Date(repo.lastSyncedAt))
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Pill
                          tone={repo.access === 'owner' ? 'human' : 'neutral'}
                        >
                          {repo.access === 'owner' ? 'Owner' : 'Viewer'}
                        </Pill>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>
      <ConnectRepositoryDialog
        open={connecting}
        onOpenChange={setConnecting}
        onConnected={(created) => navigate(`/repos/${created.id}/files`)}
      />
    </div>
  )
}
