import { Link } from 'react-router'
import type { VaultTree } from '../../api/notes.js'

interface FileTreeProps {
  vaultId: string
  tree: VaultTree
}

export function FileTree({ vaultId, tree }: FileTreeProps) {
  return (
    <nav>
      {Object.entries(tree).map(([type, notes]) => (
        <div key={type} className="mb-4">
          <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">{type}</div>
          {notes.map((note) => (
            <Link
              key={note.id}
              to={`/vaults/${vaultId}/notes/${note.path}`}
              className="block truncate rounded px-2 py-1 text-sm hover:bg-muted"
            >
              {note.name}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}
