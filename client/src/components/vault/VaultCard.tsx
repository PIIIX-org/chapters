import { Link } from 'react-router'
import { BookOpen, Folder, Network, Star } from 'lucide-react'
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card.js'
import { Pill } from '../ui/pill.js'
import { VaultRowActions } from '../shell/VaultActions.js'
import { getColorDef, type VaultColor } from './useVaultFolders.js'
import type { Vault, VaultAccess } from '../../api/vaults.js'

const ACCESS_LABEL: Record<VaultAccess, string> = {
  owner: 'Owner',
  edit: 'Can edit',
  read: 'Read only',
}

interface VaultCardProps {
  vault: Vault
  folder: string
  vaultColor?: VaultColor
  folderColor?: VaultColor
  isFavorite?: boolean
  onToggleFavorite?: (vaultId: string) => void
  onOrganizeFolder: (vault: Vault) => void
}

export function VaultCard({
  vault,
  folder,
  vaultColor,
  folderColor,
  isFavorite,
  onToggleFavorite,
  onOrganizeFolder,
}: VaultCardProps) {
  const vColorDef = getColorDef(vaultColor)
  const fColorDef = getColorDef(folderColor)

  return (
    <Card
      className={`relative flex flex-col justify-between overflow-hidden transition-all hover:border-foreground/30 ${
        vColorDef ? vColorDef.cardBorder : ''
      }`}
      style={vColorDef?.style?.cardBorder}
    >
      {/* Top color bar if vault has color */}
      {vColorDef && (
        <div
          className={`h-1 w-full ${vColorDef.cardTopBar}`}
          style={vColorDef.style?.cardTopBar}
          aria-hidden="true"
        />
      )}

      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onOrganizeFolder(vault)}
            title={folder ? `Folder: ${folder}` : 'Assign to folder'}
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
                onClick={() => onToggleFavorite(vault.id)}
                title={isFavorite ? 'Unfavorite' : 'Favorite'}
                aria-label={isFavorite ? `Unfavorite ${vault.name}` : `Favorite ${vault.name}`}
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
            <Pill tone={vault.access === 'owner' ? 'human' : 'neutral'}>
              {ACCESS_LABEL[vault.access]}
            </Pill>
          </div>
        </div>

        <div>
          <Link
            to={`/vaults/${vault.id}`}
            className="text-base font-medium text-foreground hover:underline flex items-center gap-2 group"
          >
            <BookOpen
              className={`size-4 transition-colors shrink-0 ${
                vColorDef ? vColorDef.folderIcon : 'text-muted-foreground group-hover:text-foreground'
              }`}
              style={vColorDef?.style?.folderIcon}
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

