import { Link, NavLink } from 'react-router'
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

interface RailItem {
  to: string
  label: string
  icon: LucideIcon
  chord: string
  end?: boolean
  admin?: boolean
}

const PRIMARY: RailItem[] = [
  { to: '/', label: 'Graph', icon: Waypoints, chord: 'g', end: true },
  { to: '/vaults', label: 'Vaults', icon: Library, chord: 'v' },
  { to: '/repos', label: 'Repositories', icon: GitBranch, chord: 'r' },
  { to: '/team', label: 'Team', icon: Users, chord: 't' },
  { to: '/admin', label: 'Admin', icon: ShieldCheck, chord: 'a', admin: true },
]

const SECONDARY: RailItem[] = [
  { to: '/settings', label: 'Settings', icon: Settings2, chord: 's' },
]

function RailLink({ item }: { item: RailItem }) {
  const Icon = item.icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          to={item.to}
          end={item.end}
          aria-label={item.label}
          className={({ isActive }) =>
            cn(
              'relative flex size-9 items-center justify-center rounded-[var(--radius-md)] text-muted-foreground outline-none transition-all duration-150',
              'hover:bg-muted hover:text-foreground hover:scale-105',
              'active:scale-95 active:bg-muted/80',
              'focus-visible:ring-2 focus-visible:ring-ring/40',
              isActive &&
                'bg-muted text-foreground before:absolute before:top-2 before:bottom-2 before:-left-2 before:w-0.5 before:rounded-[var(--radius-sm)] before:bg-primary shadow-xs',
            )
          }
        >
          <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="right">
        {item.label}
        <Kbd aria-hidden="true">g {item.chord}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

/** The always-present left rail. Icons only; names live in tooltips and aria. */
export function Rail() {
  const session = useSession()
  const isAdmin = isAdminRole(session.data?.role)
  const primary = PRIMARY.filter((item) => !item.admin || isAdmin)

  return (
    <nav
      aria-label="Primary"
      className="row-span-2 flex w-[52px] flex-col items-center border-r border-border bg-secondary px-2 py-2"
    >
      <Link
        to="/"
        aria-label="Chapters"
        className="mb-3 flex size-8 items-center justify-center rounded-[var(--radius-md)] bg-foreground font-mono text-[12px] font-semibold text-background outline-none transition-all duration-150 hover:scale-105 hover:opacity-90 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        Ch
      </Link>
      <ul className="flex flex-col items-center gap-1">
        {primary.map((item) => (
          <li key={item.to}>
            <RailLink item={item} />
          </li>
        ))}
      </ul>
      <ul className="mt-auto flex flex-col items-center gap-1">
        {SECONDARY.map((item) => (
          <li key={item.to}>
            <RailLink item={item} />
          </li>
        ))}
      </ul>
    </nav>
  )
}
