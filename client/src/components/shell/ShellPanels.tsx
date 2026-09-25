import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import {
  PanelContext,
  useOptionalShell,
  usePanel,
  type PanelKind,
} from './shell-context.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'
import { cn } from '../../lib/utils.js'


export function PanelRailNav({
  children,
  label,
  className,
}: {
  children: ReactNode
  label: string
  className?: string
}) {
  return (
    <nav
      aria-label={label}
      className={cn('flex flex-col items-center gap-1 w-full py-1', className)}
    >
      {children}
    </nav>
  )
}

export interface PanelRailButtonProps {
  icon: LucideIcon
  label: string
  active?: boolean
  onClick?: () => void
  side?: 'left' | 'right'
  className?: string
}

export function PanelRailButton({
  icon: Icon,
  label,
  active,
  onClick,
  side,
  className,
}: PanelRailButtonProps) {
  const panel = usePanel()
  const shell = useOptionalShell()
  const tooltipSide = side ?? (panel?.kind === 'inspector' ? 'left' : 'right')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={() => {
            onClick?.()
            if (panel?.kind) {
              shell?.setPanelOpen(panel.kind, true)
            }
          }}
          className={cn(
            'flex size-9 items-center justify-center rounded-[var(--radius-md)] text-muted-foreground outline-none transition-all duration-150',
            'hover:bg-muted hover:text-foreground active:scale-95',
            active && 'bg-muted text-foreground font-semibold shadow-xs',
            className,
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  )
}

interface PanelProps {
  children: ReactNode
  /** Collapsed icon-only view rendered when the panel is collapsed to rail width */
  collapsed?: ReactNode
  /** Accessible name; also used when the panel renders inline outside a shell. */
  label: string
  className?: string
}

/**
 * A page's content for one of the shell's side tracks. Inside <AppShell> the
 * children are portalled into the track (the page keeps its state, the shell
 * keeps the geometry). Outside one — a page rendered on its own in a test —
 * the panel renders inline, so pages never depend on the shell to be testable.
 */
function ShellPanel({
  kind,
  children,
  collapsed,
  label,
  className,
}: PanelProps & { kind: PanelKind }) {
  const shell = useOptionalShell()
  const registerPanel = shell?.registerPanel
  useEffect(() => registerPanel?.(kind), [registerPanel, kind])

  const open = shell ? shell.panels[kind].open : true
  const node = shell?.panels[kind].node
  if (shell && node) {
    return createPortal(
      <PanelContext.Provider value={{ kind, open, label }}>
        <div
          data-shell-panel={kind}
          data-panel-open={open}
          className={cn('flex min-h-full flex-col w-full', className)}
        >
          {open ? children : (collapsed ?? children)}
        </div>
      </PanelContext.Provider>,
      node,
    )
  }
  if (shell) return null
  return (
    <aside
      data-shell-panel={kind}
      data-shell-fallback=""
      aria-label={label}
      className={cn(
        kind === 'context'
          ? 'w-[var(--shell-context,240px)] border-r border-border bg-secondary'
          : 'w-[var(--shell-inspector,300px)] border-l border-border bg-card',
        className,
      )}
    >
      {children}
    </aside>
  )
}

export function ContextPanel(props: PanelProps) {
  return <ShellPanel kind="context" {...props} />
}

export function Inspector(props: PanelProps) {
  return <ShellPanel kind="inspector" {...props} />
}
