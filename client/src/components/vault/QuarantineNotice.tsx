import type { CollabQuarantine } from '../../hooks/useCollabDoc.js'
import { formatBytes } from '../../lib/noteSize.js'

interface QuarantineNoticeProps {
  quarantine: CollabQuarantine
}

/**
 * Said in place while the relay holds this note's changes back (#784,
 * `useCollabDoc`'s `quarantined`). The text in the editor repeats a large
 * block of the saved note, the way a stale tab once doubled whole notes
 * (#488), so the server keeps the saved note as it was (#492) and every
 * change since stays out of it, for everyone editing. Nothing typed is lost:
 * the server keeps it with the note (a reload brings it back) and as the
 * "Held back" revision in History. What the person needs is that the note is
 * not being saved, where the repeat starts, and that removing it saves again
 * by itself. Inline, not a dialog: they fix it in the editor below.
 */
export function QuarantineNotice({ quarantine }: QuarantineNoticeProps) {
  const { excerpt, repeatedBytes, noteBytes, revisionId } = quarantine
  return (
    <div role="status" className="border-b border-border bg-muted px-8 py-3 text-sm">
      <p className="font-medium text-foreground">Your changes are not being saved to this note.</p>
      <p className="mt-1 text-muted-foreground">
        The text below repeats about {formatBytes(repeatedBytes)} of the saved note
        {excerpt ? (
          <>
            , starting at <q className="text-foreground">{excerpt}…</q>
          </>
        ) : null}
        . That is usually a copy a stale tab put back, so the server keeps the saved note (
        {formatBytes(noteBytes)}) as it was. Nothing is lost: what you type stays here, also after a
        reload, and History keeps it as “Held back (quarantined)”
        {revisionId ? ` (revision ${revisionId.slice(0, 8)})` : ''}. Remove the repeated text and the
        note saves again.
      </p>
    </div>
  )
}
