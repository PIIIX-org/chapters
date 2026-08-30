import { useCallback, type ReactNode } from 'react'
import { Outlet } from 'react-router'
import { TooltipProvider } from '../ui/tooltip.js'
import { GlobalSearch } from '../search/GlobalSearch.js'
import { Rail } from './Rail.js'
import { TopBar } from './TopBar.js'
import { ShellProvider } from './ShellProvider.js'
import { useShell } from './shell-context.js'
import { useShellChords } from './useShellChords.js'
import { cn } from '../../lib/utils.js'

/**
 * The one authenticated shell. Everything is a grid track — rail, top bar,
 * context panel, content, inspector — so nothing can paint over anything
 * else; a page only ever renders inside its own cell. Pages fill the side
 * tracks through <ContextPanel> and <Inspector> (ShellPanels.tsx).
 *
 * Renders `children` when given (tests, storybook-style mounts) and the
 * route <Outlet> otherwise.
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
  'min-h-0 overflow-y-auto bg-card max-lg:absolute max-lg:inset-y-0 max-lg:z-30 max-lg:shadow-floating'

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
    <div className="grid h-dvh w-full grid-cols-[var(--shell-rail)_minmax(0,1fr)] grid-rows-[var(--shell-topbar)_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
      <Rail />
      <TopBar />
      <div className="relative grid min-h-0 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto]">
        <aside
          ref={contextRef}
          aria-label="Context panel"
          hidden={!contextVisible}
          className={cn(
            TRACK,
            'col-start-1 w-[var(--shell-context)] border-r border-border max-lg:left-0',
          )}
        />
        <main className="col-start-2 min-h-0 min-w-0 overflow-hidden">
          {children ?? <Outlet />}
        </main>
        <aside
          ref={inspectorRef}
          aria-label="Inspector"
          hidden={!inspectorVisible}
          className={cn(
            TRACK,
            'col-start-3 w-[var(--shell-inspector)] border-l border-border max-lg:right-0',
          )}
        />
      </div>
      <GlobalSearch />
    </div>
  )
}
