import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { useRestoreNote, useTrashedNotes } from '../../hooks/useTrash.js'

const deleted = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

function formatDate(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : deleted.format(parsed)
}

interface NoteTrashPanelProps {
  vaultId: string
}

/**
 * Deleting a note is a soft delete the app never showed anyone. This is the
 * other half: the notes that are still there, and the way back.
 */
export function NoteTrashPanel({ vaultId }: NoteTrashPanelProps) {
  const trashed = useTrashedNotes(vaultId)
  const restore = useRestoreNote(vaultId)

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-display text-base text-foreground">Trash</h3>

      {trashed.isPending ? (
        <p className="text-sm text-muted-foreground">Loading deleted notes…</p>
      ) : trashed.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {trashed.error.message}
        </p>
      ) : trashed.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing deleted. Deleting a note in this vault moves it here instead of destroying it, and it stays
          here — restorable — until the whole vault is purged.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <FormError message={restore.error?.message ?? null} />
          <ul className="flex flex-col gap-2">
            {trashed.data.map((note) => (
              <li
                key={note.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-sm text-foreground">{note.path}</span>
                  <span className="text-xs text-muted-foreground">
                    {note.type} · deleted <span className="font-mono">{formatDate(note.deletedAt)}</span>
                  </span>
                </div>
                {/* ponytail: no confirm — restoring takes nothing away, it puts
                    the note back at the path it was deleted from. */}
                <Button
                  type="button"
                  size="xs"
                  aria-label={`Restore ${note.path}`}
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(note.id)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
