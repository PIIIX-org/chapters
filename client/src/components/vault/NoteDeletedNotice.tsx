import { Button } from '../ui/button.js'

/**
 * Said in place when the note is deleted (moved to the trash) or purged while
 * open (close reason `note-deleted`): the relay closed the document and takes
 * nothing more for it. Nothing that was saved is lost while the note is in the
 * trash; what was typed here after the delete stays in this browser and comes
 * back once the note is restored and the page reloaded.
 */
export function NoteDeletedNotice() {
  return (
    <div role="status" className="border-b border-border bg-muted px-8 py-3 text-sm">
      <p className="font-medium text-foreground">This note was deleted.</p>
      <p className="mt-1 text-muted-foreground">
        It is in this vault&rsquo;s Trash, under the note list, where it can be restored. Anything you typed here since
        is kept in this browser: restore the note, then reload this page to keep editing.
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  )
}
