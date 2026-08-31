import { PanelLeft, PanelRight } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Pill } from '../ui/pill.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'
import { Kbd } from '../ui/kbd.js'
import { AccountMenu } from './AccountMenu.js'
import { Breadcrumb } from './Breadcrumb.js'
import { CommandTrigger } from './CommandTrigger.js'
import { NotificationBell } from './NotificationBell.js'
import { useShell, type PanelKind } from './shell-context.js'

function PanelToggle({ kind }: { kind: PanelKind }) {
  const shell = useShell()
  const panel = shell.panels[kind]
  if (panel.mounted === 0) return null
  const label = kind === 'context' ? 'Context panel' : 'Inspector'
  const Icon = kind === 'context' ? PanelLeft : PanelRight
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Toggle ${label.toLowerCase()}`}
          aria-pressed={panel.open}
          onClick={() => shell.togglePanel(kind)}
        >
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        <Kbd aria-hidden="true">{kind === 'context' ? '[' : ']'}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

export function TopBar() {
  const shell = useShell()
  return (
    <header className="grid h-[var(--shell-topbar)] grid-cols-[minmax(0,1fr)_minmax(0,520px)_minmax(0,1fr)] items-center gap-3 border-b border-border bg-secondary px-3">
      <Breadcrumb items={shell.breadcrumb} />
      <CommandTrigger />
      <div className="flex items-center justify-end gap-1">
        {shell.status && (
          <Pill tone={shell.status.tone} dot role="status" className="mr-1">
            {shell.status.label}
          </Pill>
        )}
        <PanelToggle kind="context" />
        <PanelToggle kind="inspector" />
        <div data-slot="notifications">
          <NotificationBell />
        </div>
        <AccountMenu />
      </div>
    </header>
  )
}
