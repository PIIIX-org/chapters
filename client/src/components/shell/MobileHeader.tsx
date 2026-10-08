import { Link, useLocation } from 'react-router'
import { PanelLeft, PanelRight, Search } from 'lucide-react'
import { useShell } from './shell-context.js'
import { Pill } from '../ui/pill.js'
import { UniversalNewButton } from './UniversalNewButton.js'
import { AccountMenu } from './AccountMenu.js'
import { NotificationBell } from './NotificationBell.js'
import { cn } from '../../lib/utils.js'

/**
 * Mobile top header conforming to the Observatory Bridge design.
 * Provides rapid touch access to context panels, page title,
 * search, universal creation, notifications, and profile.
 */
export function MobileHeader() {
  const shell = useShell()
  const location = useLocation()

  const contextMounted = shell.panels.context.mounted > 0
  const inspectorMounted = shell.panels.inspector.mounted > 0
  const contextOpen = shell.panels.context.open
  const inspectorOpen = shell.panels.inspector.open

  // Get current title from breadcrumb or route
  const currentCrumb = shell.breadcrumb[shell.breadcrumb.length - 1]?.label
  const currentTitle =
    currentCrumb ||
    (location.pathname === '/'
      ? 'Graph'
      : location.pathname.startsWith('/vaults')
        ? 'Vaults'
        : location.pathname.startsWith('/repos')
          ? 'Repositories'
          : location.pathname.startsWith('/team')
            ? 'Team'
            : location.pathname.startsWith('/admin')
              ? 'Admin'
              : location.pathname.startsWith('/settings')
                ? 'Settings'
                : 'Elara')

  return (
    <div
      aria-label="Mobile header"
      className="flex md:hidden h-13 shrink-0 items-center justify-between border-b border-border bg-card/95 px-3 backdrop-blur-md z-30 select-none"
    >
      {/* Left: Panel toggle (if context panel mounted) or Logo */}
      <div className="flex items-center gap-2 min-w-0">
        {contextMounted ? (
          <button
            type="button"
            aria-label="Toggle mobile context panel"
            aria-pressed={contextOpen}
            onClick={() => shell.togglePanel('context')}
            className={cn(
              'flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-border bg-card text-muted-foreground outline-none transition-all duration-150',
              'hover:bg-muted hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40 shrink-0 cursor-pointer',
              contextOpen && 'text-foreground bg-muted font-semibold',
            )}
          >
            <PanelLeft className="size-[18px]" aria-hidden="true" />
          </button>
        ) : (
          <Link
            to="/"
            aria-label="Elara logo"
            className="flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-border bg-card font-mono text-[13px] font-bold text-foreground outline-none transition-all duration-150 hover:bg-muted active:scale-95 shrink-0"
          >
            EL
          </Link>
        )}

        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-sm font-semibold text-foreground tracking-tight">
            {currentTitle}
          </span>
          {shell.status && (
            <div aria-hidden="true" className="inline-flex shrink-0 scale-90">
              <Pill tone={shell.status.tone} dot className="pointer-events-none">
                {shell.status.label}
              </Pill>
            </div>
          )}
        </div>
      </div>

      {/* Right Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Search trigger button */}
        <button
          type="button"
          aria-label="Search"
          onClick={() => shell.openPalette()}
          className="flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-border bg-card text-muted-foreground outline-none transition-all duration-150 hover:bg-muted hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40 shrink-0 cursor-pointer"
        >
          <Search className="size-[18px]" aria-hidden="true" />
        </button>

        {/* Universal New Action */}
        <UniversalNewButton />

        {/* Inspector panel toggle if inspector is mounted */}
        {inspectorMounted && (
          <button
            type="button"
            aria-label="Toggle mobile inspector"
            aria-pressed={inspectorOpen}
            onClick={() => shell.togglePanel('inspector')}
            className={cn(
              'flex size-9 items-center justify-center rounded-[var(--radius-md)] border border-border bg-card text-muted-foreground outline-none transition-all duration-150',
              'hover:bg-muted hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40 shrink-0 cursor-pointer',
              inspectorOpen && 'text-foreground bg-muted font-semibold',
            )}
          >
            <PanelRight className="size-[18px]" aria-hidden="true" />
          </button>
        )}

        {/* Notification Bell */}
        <div data-slot="mobile-notifications" className="shrink-0">
          <NotificationBell align="right" />
        </div>

        {/* User Account Menu */}
        <div className="shrink-0">
          <AccountMenu ariaLabel="Mobile account menu" side="bottom" align="end" />
        </div>
      </div>
    </div>
  )
}
