/**
 * Said in place, where the work is, at the moment the relay drops us.
 *
 * Not a modal and not a confirm: there is nothing to confirm — it already
 * happened — and a modal over the document would hide the one thing that
 * matters, which is the text still on screen. `useCollabDoc` never destroys the
 * `Y.Doc` on a kick precisely so that text survives; this notice's job is to
 * tell the person it is theirs to rescue, and how, before they close the tab.
 */
export function RevokedNotice() {
  return (
    <div role="status" className="border-b border-border bg-muted px-8 py-3 text-sm">
      <p className="font-medium text-foreground">Your edit access to this note was removed.</p>
      <p className="mt-1 text-muted-foreground">
        Nothing you type here reaches anyone now. Anything you had written that
        had not yet synced is still on screen — copy it somewhere safe before
        you leave this tab, then ask the vault owner to share it with you again.
      </p>
    </div>
  )
}
