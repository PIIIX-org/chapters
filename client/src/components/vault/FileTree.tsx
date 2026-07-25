import { Link } from 'react-router'
import { NoteActions } from './NoteActions.js'
import type { VaultTree } from '../../api/notes.js'

interface FileTreeProps {
  vaultId: string
  tree: VaultTree
  canEdit: boolean
}

export function FileTree({ vaultId, tree, canEdit }: FileTreeProps) {
  return (
    <nav>
      {Object.entries(tree).map(([type, notes]) => (
        <div key={type} className="mb-4">
          <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">{type}</div>
          {notes.map((note) => (
            <div key={note.id} className="flex items-center justify-between gap-1">
              <Link
                to={`/vaults/${vaultId}/notes/${note.path}`}
                className="min-w-0 flex-1 truncate rounded px-2 py-1 text-sm hover:bg-muted"
              >
                {note.name}
              </Link>
              {canEdit && <NoteActions vaultId={vaultId} note={note} />}
            </div>
          ))}
        </div>
      ))}
    </nav>
  )
}
