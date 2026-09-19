import { Link } from 'react-router'
import { FileText, Folder, Star } from 'lucide-react'
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card.js'
import { Pill } from '../ui/pill.js'
import { getColorDef, type VaultColor } from './useVaultFolders.js'
import { NoteActions } from './NoteActions.js'
import type { NoteSummary } from '../../api/notes.js'

interface NoteCardProps {
  note: NoteSummary
  vaultId: string
  folder: string
  noteColor?: VaultColor
  folderColor?: VaultColor
  isFavorite?: boolean
  onToggleFavorite?: (noteId: string) => void
  onOrganizeFolder: (note: NoteSummary) => void
  canEdit?: boolean
}

export function NoteCard({
  note,
  vaultId,
  folder,
  noteColor,
  folderColor,
  isFavorite,
  onToggleFavorite,
  onOrganizeFolder,
  canEdit = false,
}: NoteCardProps) {
  const nColorDef = getColorDef(noteColor)
  const fColorDef = getColorDef(folderColor)

  const updatedDate = note.updatedAt
    ? new Date(note.updatedAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null

  return (
    <Card
      className={`relative flex flex-col justify-between overflow-hidden transition-all hover:border-foreground/30 ${
        nColorDef ? nColorDef.cardBorder : ''
      }`}
      style={nColorDef?.style?.cardBorder}
    >
      {/* Top color bar if note has accent color */}
      {nColorDef && (
        <div
          className={`h-1 w-full ${nColorDef.cardTopBar}`}
          style={nColorDef.style?.cardTopBar}
          aria-hidden="true"
        />
      )}

      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onOrganizeFolder(note)}
            title={folder ? `Folder: ${folder}` : 'Assign to folder'}
            aria-label={folder ? `Folder: ${folder} for ${note.name}` : `Assign folder for ${note.name}`}
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
                onClick={() => onToggleFavorite(note.id)}
                title={isFavorite ? 'Unfavorite' : 'Favorite'}
                aria-label={isFavorite ? `Unfavorite ${note.name}` : `Favorite ${note.name}`}
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
            {note.type && <Pill tone="neutral">{note.type}</Pill>}
          </div>
        </div>

        <div>
          <Link
            to={`/vaults/${vaultId}/notes/${note.path}`}
            className="text-base font-medium text-foreground hover:underline flex items-center gap-2 group"
          >
            <FileText
              className={`size-4 transition-colors shrink-0 ${
                nColorDef ? nColorDef.folderIcon : 'text-muted-foreground group-hover:text-foreground'
              }`}
              style={nColorDef?.style?.folderIcon}
              aria-hidden="true"
            />
            <span className="truncate">{note.name}</span>
          </Link>
          {updatedDate && (
            <div className="text-[11px] text-muted-foreground mt-1">
              Updated {updatedDate}
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {/* Additional metadata can slot here */}
      </CardContent>

      <CardFooter className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2.5">
        <Link
          to={`/vaults/${vaultId}/notes/${note.path}`}
          className="text-xs text-primary hover:underline font-medium"
        >
          Open note &rarr;
        </Link>
        {canEdit && (
          <div className="flex items-center gap-2">
            <NoteActions vaultId={vaultId} note={note} />
          </div>
        )}
      </CardFooter>
    </Card>
  )
}
