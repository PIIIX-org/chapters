import { Link } from 'react-router'
import { BookOpen, Folder, Network } from 'lucide-react'
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card.js'
import { Pill } from '../ui/pill.js'
import { VaultRowActions } from '../shell/VaultActions.js'
import type { Vault, VaultAccess } from '../../api/vaults.js'

const ACCESS_LABEL: Record<VaultAccess, string> = {
  owner: 'Owner',
  edit: 'Can edit',
  read: 'Read only',
}

interface VaultCardProps {
  vault: Vault
  folder: string
  onOrganizeFolder: (vault: Vault) => void
}

export function VaultCard({
  vault,
  folder,
  onOrganizeFolder,
}: VaultCardProps) {
  return (
    <Card className="flex flex-col justify-between hover:border-foreground/30 transition-colors">
      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onOrganizeFolder(vault)}
            title={folder ? `Folder: ${folder}` : 'Assign to folder'}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-mono bg-muted/40 hover:bg-muted px-2 py-0.5 rounded border border-border/60 transition-colors"
          >
            <Folder className="size-3 text-muted-foreground" aria-hidden="true" />
            <span className="truncate max-w-[120px]">
              {folder || 'Add folder'}
            </span>
          </button>
          <Pill tone={vault.access === 'owner' ? 'human' : 'neutral'}>
            {ACCESS_LABEL[vault.access]}
          </Pill>
        </div>

        <div>
          <Link
            to={`/vaults/${vault.id}`}
            className="text-base font-medium text-foreground hover:underline flex items-center gap-2 group"
          >
            <BookOpen
              className="size-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0"
              aria-hidden="true"
            />
            <span className="truncate">{vault.name}</span>
          </Link>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1.5">
            <Network className="size-3 shrink-0" aria-hidden="true" />
            <span>{vault.mergeable ? 'Merged view: Included' : 'Merged view: Excluded'}</span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {/* Additional metadata or stats can slot here */}
      </CardContent>

      <CardFooter className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2.5">
        <Link
          to={`/vaults/${vault.id}`}
          className="text-xs text-primary hover:underline font-medium"
        >
          Open vault &rarr;
        </Link>
        <div className="flex items-center gap-2">
          {vault.access === 'owner' && <VaultRowActions vault={vault} />}
        </div>
      </CardFooter>
    </Card>
  )
}
