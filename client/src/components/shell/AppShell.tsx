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
    <div className="relative h-dvh w-full overflow-hidden bg-background text-foreground">
      {/* Full-screen workspace canvas */}
      <main className="relative h-full w-full min-h-0 min-w-0 overflow-hidden">
        {children ?? <Outlet />}
      </main>

      {/* Floating Side Panels */}
      <aside
        ref={contextRef}
        data-shell-panel="context"
        aria-label="Context panel"
        hidden={!contextVisible}
        className={cn(
          'pointer-events-auto absolute top-[194px] bottom-[222px] left-2.5 z-20 flex w-[var(--shell-context,240px)] flex-col rounded-[var(--radius-lg)] border border-border bg-card shadow-floating transition-all duration-200 min-h-0 overflow-y-auto',
        )}
      />

      <aside
        ref={inspectorRef}
        data-shell-panel="inspector"
        aria-label="Inspector"
        hidden={!inspectorVisible}
        className={cn(
          'pointer-events-auto absolute top-[54px] bottom-[54px] right-2.5 z-20 flex w-[var(--shell-inspector,320px)] flex-col rounded-[var(--radius-lg)] border border-border bg-card shadow-floating transition-all duration-200 min-h-0 overflow-y-auto',
        )}
      />

      {/* Floating navigation overlay layer */}
      <div className="pointer-events-none fixed inset-0 z-30 select-none overflow-hidden">
        {/* Floating Rail on the Left */}
        <div className="pointer-events-none absolute inset-y-2.5 left-2.5 flex flex-col">
          <Rail />
        </div>

        {/* Floating TopBar on the Top Right */}
        <div className="pointer-events-none absolute top-2.5 right-2.5 flex items-center justify-end">
          <TopBar />
        </div>

        {/* Floating BottomBar along the Bottom */}
        <div className="pointer-events-none absolute bottom-2.5 inset-x-0 flex items-center justify-between px-2.5">
          <BottomBar />
        </div>
      </div>

      <GlobalSearch />
    </div>
  )
}
