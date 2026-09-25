import { useCallback, type ReactNode } from 'react'
import { Outlet } from 'react-router'
import { TooltipProvider } from '../ui/tooltip.js'
import { GlobalSearch } from '../search/GlobalSearch.js'
import { Rail } from './Rail.js'
import { TopBar } from './TopBar.js'
import { BottomBar } from './BottomBar.js'
import { ShellProvider } from './ShellProvider.js'
import { useShell } from './shell-context.js'
import { useShellChords } from './useShellChords.js'
import { cn } from '../../lib/utils.js'

/**
 * The authenticated shell conforming to the Observatory Bridge design system.
 * Layout grid:
 * - Column 1 (full height): Rail with top CH logo toggle and navigation cards.
 * - Column 2 Row 1: TopBar with live status telemetry and expandable search.
 * - Column 2 Row 2: Central workspace with Context panel, main view, and Inspector panel.
 * - Column 2 Row 3: BottomBar with history navigation, breadcrumb, and panel toggles.
 */
export function AppShell({ children }: { children?: ReactNode }) {
  return (
    <ShellProvider>
      <TooltipProvider delayDuration={300} skipDelayDuration={200}>
        <ShellFrame>{children}</ShellFrame>
      </TooltipProvider>
    </ShellProvider>
  )
}

const TRACK =
  'min-h-0 overflow-y-auto max-lg:absolute max-lg:inset-y-0 max-lg:z-30 max-lg:shadow-floating'

function ShellFrame({ children }: { children?: ReactNode }) {
  const shell = useShell()
  useShellChords()
  const { setPanelNode } = shell
  const contextRef = useCallback(
    (node: HTMLElement | null) => setPanelNode('context', node),
    [setPanelNode],
  )
  const inspectorRef = useCallback(
    (node: HTMLElement | null) => setPanelNode('inspector', node),
    [setPanelNode],
  )
  const contextVisible =
    shell.panels.context.mounted > 0 && shell.panels.context.open
  const inspectorVisible =
    shell.panels.inspector.mounted > 0 && shell.panels.inspector.open

  return (
    <div className="grid h-dvh w-full grid-cols-[auto_minmax(0,1fr)] grid-rows-[var(--shell-topbar,44px)_minmax(0,1fr)_var(--shell-bottombar,44px)] overflow-hidden bg-background text-foreground">
      <Rail />
      <TopBar />
      <div className="relative grid min-h-0 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto]">
        <aside
          ref={contextRef}
          data-shell-panel="context"
          aria-label="Context panel"
          hidden={!contextVisible}
          className={cn(
            TRACK,
            'col-start-1 w-[var(--shell-context)] border-r border-border bg-secondary max-lg:left-0',
          )}
        />
        <main className="col-start-2 min-h-0 min-w-0 overflow-hidden">
          {children ?? <Outlet />}
        </main>
        <aside
          ref={inspectorRef}
          data-shell-panel="inspector"
          aria-label="Inspector"
          hidden={!inspectorVisible}
          className={cn(
            TRACK,
            'col-start-3 w-[var(--shell-inspector)] border-l border-border bg-card max-lg:right-0',
          )}
        />
      </div>
      <BottomBar />
      <GlobalSearch />
    </div>
  )
}
