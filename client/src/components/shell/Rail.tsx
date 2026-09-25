import { NavLink } from 'react-router'
import {
  GitBranch,
  Library,
  Settings2,
  ShieldCheck,
  Users,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import { Kbd } from '../ui/kbd.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'
import { useSession } from '../../hooks/useSession.js'
import { cn } from '../../lib/utils.js'
import { isAdminRole } from '../../api/admin.js'
import { useShell } from './shell-context.js'
import { NotificationBell } from './NotificationBell.js'
import { AccountMenu } from './AccountMenu.js'

interface RailItem {
  to: string
  label: string
  display: string
  icon: LucideIcon
  chord: string
  end?: boolean
  admin?: boolean
}

const PRIMARY: RailItem[] = [
  { to: '/', label: 'Graph', display: 'Graphs', icon: Waypoints, chord: 'g', end: true },
  { to: '/vaults', label: 'Vaults', display: 'Vaults', icon: Library, chord: 'v' },
  { to: '/repos', label: 'Repositories', display: 'Repos', icon: GitBranch, chord: 'r' },
]

const SECONDARY: RailItem[] = [
  { to: '/team', label: 'Team', display: 'Team', icon: Users, chord: 't' },
  { to: '/admin', label: 'Admin', display: 'Admin', icon: ShieldCheck, chord: 'a', admin: true },
  { to: '/settings', label: 'Settings', display: 'Settings', icon: Settings2, chord: 's' },
]

function RailLink({ item, expanded }: { item: RailItem; expanded: boolean }) {
  const Icon = item.icon
  return (
    <Tooltip>
      <NavLink
        to={item.to}
        end={item.end}
        aria-label={item.label}
        className={({ isActive }) =>
          cn(
            'relative flex items-center justify-center rounded-[var(--radius-md)] text-muted-foreground outline-none transition-all duration-150',
            'hover:bg-muted hover:text-foreground',
            'active:scale-[0.98] active:bg-muted/80',
            'focus-visible:ring-2 focus-visible:ring-ring/40',
            expanded
              ? 'h-9 w-full justify-start gap-2.5 px-2.5 text-[13px] font-medium'
              : 'h-9 w-full justify-center p-0 hover:scale-105',
            isActive &&
              cn(
                'bg-muted text-foreground shadow-xs',
                expanded
                  ? 'before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-[var(--radius-sm)] before:bg-primary font-semibold'
                  : 'before:absolute before:left-0.5 before:top-2 before:bottom-2 before:w-0.5 before:rounded-full before:bg-primary',
              ),
          )
        }
      >
        <TooltipTrigger asChild>
          <span className={cn('flex items-center justify-center', expanded ? 'w-full justify-start gap-2.5' : 'size-full')}>
            <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
            {expanded && <span className="truncate">{item.display}</span>}
          </span>
        </TooltipTrigger>
        {expanded && (
          <span className="ml-auto opacity-70">
            <Kbd aria-hidden="true">g {item.chord}</Kbd>
          </span>
        )}
      </NavLink>
      {!expanded && (
        <TooltipContent side="right">
          {item.label}
          <Kbd aria-hidden="true">g {item.chord}</Kbd>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

/** The primary navigation rail with standalone CH logo button and centered dual-card navigation. */
export function Rail() {
  const shell = useShell()
  const session = useSession()
  const isAdmin = isAdminRole(session.data?.role)
  const primary = PRIMARY
  const secondary = SECONDARY.filter((item) => !item.admin || isAdmin)
  const expanded = shell.sidebarExpanded

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'flex h-full flex-col items-center gap-2 bg-transparent border-none pointer-events-none transition-[width] duration-200 ease-in-out select-none',
        expanded ? 'w-[200px]' : 'w-[52px]',
      )}
    >
      <div className={cn('flex w-full items-center pointer-events-auto', expanded ? 'justify-start' : 'justify-center')}>
        <button
          type="button"
          onClick={shell.toggleSidebar}
          aria-label="Chapters logo, toggle sidebar"
          aria-expanded={expanded}
          className={cn(
            'flex items-center justify-center rounded-[var(--radius-md)] border border-border bg-card font-mono text-[13px] font-bold text-foreground outline-none transition-all duration-150 hover:bg-muted hover:border-input active:scale-95 shadow-floating focus-visible:ring-2 focus-visible:ring-ring/40',
            expanded ? 'h-11 w-full justify-between px-3' : 'size-11',
          )}
        >
          <span>CH</span>
          {expanded && <span className="font-sans text-xs font-normal text-muted-foreground">Chapters</span>}
        </button>
      </div>

      {/* Upper Navigation Card (Graphs, Vaults, Repos) */}
      <div
        className={cn(
          'flex flex-col gap-1 rounded-[var(--radius-lg)] border border-border bg-card p-1 pointer-events-auto shadow-floating',
          expanded ? 'w-full' : 'w-11 items-center',
        )}
      >
        <ul className="flex flex-col gap-1 w-full items-center">
          {primary.map((item) => (
            <li key={item.to} className="w-full flex justify-center">
              <RailLink item={item} expanded={expanded} />
            </li>
          ))}
        </ul>
      </div>

      {/* Lower Navigation Card (Team, Admin, Settings, Notifications, Profile) */}
      <div
        className={cn(
          'mt-auto flex flex-col gap-1 rounded-[var(--radius-lg)] border border-border bg-card p-1 pointer-events-auto shadow-floating',
          expanded ? 'w-full' : 'w-11 items-center',
        )}
      >
        <ul className="flex flex-col gap-1 w-full items-center">
          {secondary.map((item) => (
            <li key={item.to} className="w-full flex justify-center">
              <RailLink item={item} expanded={expanded} />
            </li>
          ))}
          <li data-slot="notifications" className="w-full flex justify-center">
            <NotificationBell showLabel={expanded} />
          </li>
          <li className="w-full flex justify-center">
            <AccountMenu showLabel={expanded} />
          </li>
        </ul>
      </div>
    </nav>
  )
}
