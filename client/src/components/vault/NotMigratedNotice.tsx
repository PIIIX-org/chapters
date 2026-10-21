/**
 * Said in place when the relay refuses the note because the server's store
 * migration has not processed it yet (ADR-003, close reason
 * `note-not-migrated`). Nothing typed here could be stored, so the editor is
 * locked; the note itself is safe on the server, and reading it still works.
 */
export function NotMigratedNotice() {
  return (
    <div role="status" className="border-b border-border bg-muted px-8 py-3 text-sm">
      <p className="font-medium text-foreground">This note is waiting for the store migration.</p>
      <p className="mt-1 text-muted-foreground">
        It cannot be edited until the migration has processed it: an admin needs to fix the cause shown in the
        migration report and restart the server. Your note is safe; nothing you had saved is lost.
      </p>
    </div>
  )
}
