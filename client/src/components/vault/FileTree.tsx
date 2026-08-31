import { NavLink } from 'react-router'
import { Eyebrow } from '../ui/eyebrow.js'
import { NoteActions } from './NoteActions.js'
import { cn } from '../../lib/utils.js'
import type { VaultTree } from '../../api/notes.js'

interface FileTreeProps {
  vaultId: string
  tree: VaultTree
  canEdit: boolean
}

/**
 * The vault's navigation, grouped by note type: mono eyebrow group headers,
 * sans note names, the open note marked via NavLink's `aria-current="page"`.
 *
 * Row actions (rename/delete) are revealed on hover and focus only, but they
 * are always in the DOM and always focusable — opacity, never `display:none`,
 * so a keyboard user tabs straight to them.
 */
export function FileTree({ vaultId, tree, canEdit }: FileTreeProps) {
  return (
    <nav aria-label="Notes">
      {Object.entries(tree).map(([type, notes]) => (
        <div key={type} className="mb-3">
          <Eyebrow as="h3" className="px-2 pt-1.5 pb-1">
            {type}
          </Eyebrow>
          <ul className="flex flex-col">
            {notes.map((note) => (
              <li
                key={note.id}
                className="group flex min-h-7 items-center gap-1 rounded-md pr-1 hover:bg-muted focus-within:bg-muted"
              >
                <NavLink
                  to={`/vaults/${vaultId}/notes/${note.path}`}
                  className={({ isActive }) =>
                    cn(
                      'min-w-0 flex-1 truncate rounded-md px-2 py-1 text-sm',
                      isActive
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )
                  }
                >
                  {note.name}
                </NavLink>
                {canEdit && (
                  <span className="opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                    <NoteActions vaultId={vaultId} note={note} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}
