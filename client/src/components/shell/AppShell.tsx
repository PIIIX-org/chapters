import { useCallback, useEffect, type ReactNode } from 'react'
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
  const contextMounted = shell.panels.context.mounted > 0
  const inspectorMounted = shell.panels.inspector.mounted > 0
  const contextOpen = shell.panels.context.open
  const inspectorOpen = shell.panels.inspector.open

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !shell.paletteOpen && (contextOpen || inspectorOpen)) {
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          if (contextOpen) shell.setPanelOpen('context', false)
          if (inspectorOpen) shell.setPanelOpen('inspector', false)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [contextOpen, inspectorOpen, shell])

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
        data-panel-open={contextOpen}
        aria-label="Context panel"
        hidden={!contextMounted}
        className={cn(
          'pointer-events-auto absolute top-[194px] bottom-[222px] left-2.5 z-20 flex flex-col rounded-[var(--radius-lg)] border border-border bg-card shadow-floating transition-all duration-200 min-h-0',
          contextOpen
            ? 'w-[var(--shell-context,240px)] overflow-y-auto max-md:fixed max-md:inset-y-0 max-md:top-0 max-md:bottom-0 max-md:left-0 max-md:z-40 max-md:w-[min(320px,85vw)] max-md:rounded-none max-md:shadow-2xl'
            : 'w-11 items-center p-1 overflow-hidden max-md:hidden',
        )}
      />

      <aside
        ref={inspectorRef}
        data-shell-panel="inspector"
        data-panel-open={inspectorOpen}
        aria-label="Inspector"
        hidden={!inspectorMounted}
        className={cn(
          'pointer-events-auto absolute top-[54px] bottom-[54px] right-2.5 z-20 flex flex-col rounded-[var(--radius-lg)] border border-border bg-card shadow-floating transition-all duration-200 min-h-0',
          inspectorOpen
            ? 'w-[var(--shell-inspector,320px)] overflow-y-auto max-md:fixed max-md:inset-y-0 max-md:top-0 max-md:bottom-0 max-md:right-0 max-md:z-40 max-md:w-[min(320px,85vw)] max-md:rounded-none max-md:shadow-2xl'
            : 'w-11 items-center p-1 overflow-hidden max-md:hidden',
        )}
      />

      {/* Mobile drawer backdrop */}
      {((contextMounted && contextOpen) || (inspectorMounted && inspectorOpen)) && (
        <div
          data-testid="shell-backdrop"
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-xs md:hidden pointer-events-auto"
          onClick={() => {
            if (contextOpen) shell.setPanelOpen('context', false)
            if (inspectorOpen) shell.setPanelOpen('inspector', false)
          }}
        />
      )}

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
