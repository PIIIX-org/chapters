import { NavLink, useLocation } from 'react-router'
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
  const shell = useShell()
  const Icon = item.icon
  const location = useLocation()
  const isActive = item.end
    ? location.pathname === item.to
    : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)

  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      aria-label={item.label}
      aria-current={isActive ? 'page' : undefined}
      onClick={() => {
        if (expanded && typeof window !== 'undefined' && window.innerWidth < 768) {
          shell.setSidebarExpanded(false)
        }
      }}
      className={cn(
        'relative flex items-center rounded-[var(--radius-md)] text-muted-foreground outline-none transition-all duration-150',
        'hover:bg-muted hover:text-foreground',
        'active:scale-[0.98] active:bg-muted/80',
        'focus-visible:ring-2 focus-visible:ring-ring/40',
        expanded
          ? 'h-9 w-full justify-between px-2.5 text-[13px] font-medium shrink-0'
          : 'size-9 justify-center p-0 hover:scale-105 shrink-0',
        isActive &&
          cn(
            'bg-muted text-foreground shadow-xs',
            expanded
              ? 'before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-[var(--radius-sm)] before:bg-primary font-semibold'
              : 'before:absolute before:left-0.5 before:top-2 before:bottom-2 before:w-0.5 before:rounded-full before:bg-primary',
          ),
      )}
    >
      <span className={cn('flex items-center min-w-0', expanded ? 'flex-1 gap-2.5 truncate' : 'justify-center size-full')}>
        <Icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden="true" />
        {expanded && <span className="truncate">{item.display}</span>}
      </span>
      {expanded && (
        <span className="shrink-0 ml-2 opacity-70">
          <Kbd aria-hidden="true">g {item.chord}</Kbd>
        </span>
      )}
    </NavLink>
  )

  if (expanded) {
    return link
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        <span>{item.label}</span>
        <Kbd aria-hidden="true">g {item.chord}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

export function Rail() {
  const shell = useShell()
  const session = useSession()
  const isAdmin = isAdminRole(session.data?.role)
  const navItems = [...PRIMARY, ...SECONDARY.filter((item) => !item.admin || isAdmin)]
  const expanded = shell.sidebarExpanded

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'flex h-full flex-col justify-between border-r border-border bg-card shrink-0 transition-[width] duration-200 ease-in-out select-none p-1 z-20',
        expanded ? 'w-[var(--shell-context,240px)]' : 'w-11 items-center',
      )}
    >
      <div className="flex flex-col gap-1 w-full items-center">
        {/* Permanent Logo / Sidebar Toggle */}
        <div className={cn('flex w-full items-center', expanded ? 'justify-start' : 'justify-center')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={shell.toggleSidebar}
                aria-label="Elara logo, toggle sidebar"
                aria-expanded={expanded}
                className={cn(
                  'flex items-center justify-center rounded-[var(--radius-md)] border border-border bg-card font-mono text-[13px] font-bold text-foreground outline-none transition-all duration-150 hover:bg-muted hover:border-input active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40 cursor-pointer',
                  expanded ? 'h-9 w-full justify-between px-3' : 'size-9',
                )}
              >
                <span>EL</span>
                {expanded && <span className="font-sans text-xs font-normal text-muted-foreground">Elara</span>}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <span>Toggle navigation</span>
              <Kbd aria-hidden="true">\</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* User Profile (Drawing 1) */}
        <div className="w-full flex justify-center shrink-0">
          <AccountMenu showLabel={expanded} />
        </div>

        {/* Unbroken Contiguous Navigational Tabs (Drawings 1 & 2) */}
        <ul className="flex flex-col gap-1 w-full items-center">
          {navItems.map((item) => (
            <li key={item.to} className="w-full flex justify-center shrink-0">
              <RailLink item={item} expanded={expanded} />
            </li>
          ))}
        </ul>
      </div>

      {/* Notifications Card Stack & Bell at bottom (Drawing 1) */}
      <div className="flex flex-col gap-1 w-full items-center shrink-0 pt-2">
        <ul className="flex flex-col gap-1 w-full items-center">
          <li data-slot="notifications" className="w-full flex justify-center shrink-0">
            <NotificationBell showLabel={expanded} />
          </li>
        </ul>
      </div>
    </nav>
  )
}
