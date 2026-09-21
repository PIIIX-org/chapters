import { NavLink } from 'react-router'
import { ChevronDown } from 'lucide-react'
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
 * The vault's navigation, grouped by note type: mono eyebrow group headers with
 * subtle folder chevrons, sans note names with hairline hierarchy lines, the open
 * note marked via NavLink's `aria-current="page"` and Human Primary blue (#5B8DEF) indicator.
 *
 * Row actions (rename/delete) are revealed on hover and focus only, but they
 * are always in the DOM and always focusable — opacity, never `display:none`,
 * so a keyboard user tabs straight to them.
 */
export function FileTree({ vaultId, tree, canEdit }: FileTreeProps) {
  return (
    <nav aria-label="Notes">
      {Object.entries(tree).map(([type, notes]) => (
        <div key={type} className="mb-2.5">
          <div className="flex h-6 items-center gap-1.5 px-2 text-faint select-none">
            <ChevronDown className="size-3 shrink-0 text-faint/70" aria-hidden="true" />
            <Eyebrow as="h3" className="truncate">
              {type}
            </Eyebrow>
          </div>
          <ul className="relative ml-2.5 flex flex-col border-l border-border/60 pl-2 gap-0.5">
            {notes.map((note) => (
              <li
                key={note.id}
                className="group relative flex min-h-7 items-center gap-1 rounded-[var(--radius-sm,2px)] pr-1 hover:bg-muted/60 focus-within:bg-muted/60"
              >
                <NavLink
                  to={`/vaults/${vaultId}/notes/${note.path}`}
                  className={({ isActive }) =>
                    cn(
                      'relative min-w-0 flex-1 truncate rounded-[var(--radius-sm,2px)] px-2 py-1 text-sm outline-none transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-ring/40',
                      isActive
                        ? 'bg-muted text-foreground font-medium before:absolute before:left-0 before:top-1 before:bottom-1 before:w-0.5 before:rounded-[var(--radius-sm,2px)] before:bg-[#5B8DEF]'
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
