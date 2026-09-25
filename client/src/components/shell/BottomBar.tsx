import { ArrowLeft, ArrowRight, PanelLeft, PanelRight } from 'lucide-react'
import { Breadcrumb } from './Breadcrumb.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'
import { Kbd } from '../ui/kbd.js'
import { useShell, type PanelKind } from './shell-context.js'
import { cn } from '../../lib/utils.js'

function PanelToggle({ kind }: { kind: PanelKind }) {
  const shell = useShell()
  const panel = shell.panels[kind]
  if (panel.mounted === 0) return null
  const label = kind === 'context' ? 'Context panel' : 'Inspector'
  const Icon = kind === 'context' ? PanelLeft : PanelRight
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Toggle ${label.toLowerCase()}`}
          aria-pressed={panel.open}
          onClick={() => shell.togglePanel(kind)}
          className={cn(
            'flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-border bg-card text-muted-foreground outline-none transition-all duration-150',
            'hover:bg-muted hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40',
            panel.open && 'text-foreground bg-muted/60',
          )}
        >
          <Icon className="size-[18px]" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        <Kbd aria-hidden="true">{kind === 'context' ? '[' : ']'}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

export function BottomBar() {
  const shell = useShell()

  return (
    <footer className="flex h-11 items-center justify-between gap-3 border-t border-border bg-secondary px-3 select-none">
      {/* Left: History navigation & Breadcrumbs */}
      <div className="flex items-center gap-1.5 min-w-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => window.history.back()}
              aria-label="Go back"
              className="flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-border bg-card text-muted-foreground outline-none transition-all duration-150 hover:bg-muted hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ArrowLeft className="size-[18px]" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Go back</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => window.history.forward()}
              aria-label="Go forward"
              className="flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-border bg-card text-muted-foreground outline-none transition-all duration-150 hover:bg-muted hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ArrowRight className="size-[18px]" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Go forward</TooltipContent>
        </Tooltip>

        <div className="flex h-9 items-center gap-1 rounded-[var(--radius-md)] border border-border bg-card px-2.5 min-w-0 max-w-[420px]">
          <Breadcrumb items={shell.breadcrumb} />
          <span aria-hidden="true" className="text-faint font-mono text-[12px] select-none shrink-0">
            /
          </span>
        </div>
      </div>

      {/* Right: Layout panel toggles */}
      <div className="flex items-center gap-1.5 shrink-0">
        <PanelToggle kind="context" />
        <PanelToggle kind="inspector" />
      </div>
    </footer>
  )
}
