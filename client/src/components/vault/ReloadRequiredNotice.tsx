import { Button } from '../ui/button.js'

/**
 * Said in place when the relay refuses this tab's document name (ADR-003
 * §5.4, close reason `reload-required`): the server names collab documents
 * differently from the bundle this tab runs, so nothing typed here reaches
 * it until the page reloads. What was typed stays in this browser (#720) and
 * is merged once, or offered as text, after the reload. Not "access removed":
 * that wording invites closing the tab.
 */
export function ReloadRequiredNotice() {
  return (
    <div role="status" className="border-b border-border bg-muted px-8 py-3 text-sm">
      <p className="font-medium text-foreground">Reload to keep editing.</p>
      <p className="mt-1 text-muted-foreground">
        The server was updated. Reload this page: what you typed here is kept in this browser and comes back after the
        reload.
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  )
}
