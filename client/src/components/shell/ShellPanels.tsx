import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOptionalShell, type PanelKind } from './shell-context.js'
import { cn } from '../../lib/utils.js'

interface PanelProps {
  children: ReactNode
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
  label,
  className,
}: PanelProps & { kind: PanelKind }) {
  const shell = useOptionalShell()
  const registerPanel = shell?.registerPanel
  useEffect(() => registerPanel?.(kind), [registerPanel, kind])

  const node = shell?.panels[kind].node
  if (shell && node) {
    return createPortal(
      <div
        data-shell-panel={kind}
        className={cn('flex min-h-full flex-col', className)}
      >
        {children}
      </div>,
      node,
    )
  }
  if (shell) return null
  return (
    <aside
      data-shell-panel={kind}
      data-shell-fallback=""
      aria-label={label}
      className={className}
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
