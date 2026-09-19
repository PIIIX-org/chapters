import { Link } from 'react-router'
import { Folder, GitBranch, Star } from 'lucide-react'
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card.js'
import { Pill, type PillTone } from '../ui/pill.js'
import { getColorDef, type VaultColor } from '../vault/useVaultFolders.js'
import {
  syncHealth,
  type AccessibleRepository,
  type IngestionMethod,
  type Repository,
  type SyncHealth,
} from '../../api/repositories.js'

interface RepoCardProps {
  repo: AccessibleRepository
  folder: string
  repoColor?: VaultColor
  folderColor?: VaultColor
  isFavorite?: boolean
  onToggleFavorite?: (repoId: string) => void
  onOrganizeFolder: (repo: Repository) => void
}

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

export function RepoCard({
  repo,
  folder,
  repoColor,
  folderColor,
  isFavorite,
  onToggleFavorite,
  onOrganizeFolder,
}: RepoCardProps) {
  const rColorDef = getColorDef(repoColor)
  const fColorDef = getColorDef(folderColor)
  const health = HEALTH[syncHealth(repo)]

  return (
    <Card
      className={`relative flex flex-col justify-between overflow-hidden transition-all hover:border-foreground/30 ${
        rColorDef ? rColorDef.cardBorder : ''
      }`}
      style={rColorDef?.style?.cardBorder}
    >
      {/* Top accent color bar */}
      {rColorDef && (
        <div
          className={`h-1 w-full ${rColorDef.cardTopBar}`}
          style={rColorDef.style?.cardTopBar}
          aria-hidden="true"
        />
      )}

      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onOrganizeFolder(repo)}
            title={folder ? `Folder: ${folder}` : 'Assign to folder'}
            aria-label={
              folder
                ? `Folder: ${folder} for ${repo.name}`
                : `Assign folder for ${repo.name}`
            }
            className={`flex items-center gap-1.5 text-xs font-mono px-2 py-0.5 rounded border transition-colors ${
              fColorDef
                ? fColorDef.badge
                : 'text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted border-border/60'
            }`}
            style={fColorDef?.style?.badge}
          >
            <Folder
              className={`size-3 ${fColorDef ? fColorDef.folderIcon : 'text-muted-foreground'}`}
              style={fColorDef?.style?.folderIcon}
              aria-hidden="true"
            />
            <span className="truncate max-w-[120px]">
              {folder || 'Add folder'}
            </span>
          </button>

          <div className="flex items-center gap-1.5">
            {onToggleFavorite && (
              <button
                type="button"
                onClick={() => onToggleFavorite(repo.id)}
                title={isFavorite ? 'Unfavorite' : 'Favorite'}
                aria-label={isFavorite ? `Unfavorite ${repo.name}` : `Favorite ${repo.name}`}
                className={`p-1 rounded transition-colors ${
                  isFavorite
                    ? 'text-amber-500 hover:text-amber-600'
                    : 'text-muted-foreground/40 hover:text-amber-500'
                }`}
              >
                <Star
                  className={`size-3.5 ${isFavorite ? 'fill-amber-500 text-amber-500' : ''}`}
                  aria-hidden="true"
                />
              </button>
            )}
            <Pill tone={repo.access === 'owner' ? 'human' : 'neutral'}>
              {repo.access === 'owner' ? 'Owner' : 'Viewer'}
            </Pill>
          </div>
        </div>

        <div className="mt-1 flex items-start gap-2">
          <GitBranch className="size-4 text-muted-foreground mt-0.5 shrink-0" aria-hidden="true" />
          <Link
            to={`/repos/${repo.id}/files`}
            className="font-medium text-foreground hover:underline truncate"
          >
            {repo.name}
          </Link>
        </div>
      </CardHeader>

      <CardContent className="py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Pill tone="neutral">{METHOD_LABEL[repo.ingestionMethod]}</Pill>
          <Pill tone={health.tone} dot>
            {health.label}
          </Pill>
        </div>
      </CardContent>

      <CardFooter className="text-xs text-muted-foreground border-t border-border/60 pt-2.5 pb-2.5 flex items-center justify-between">
        <span className="font-mono text-[11px]">
          {repo.lastSyncedAt
            ? `Synced ${syncedFormatter.format(new Date(repo.lastSyncedAt))}`
            : 'Never synced'}
        </span>
      </CardFooter>
    </Card>
  )
}
