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
import { useSession } from '../../hooks/useSession.js'
import { isAdminRole } from '../../api/admin.js'
import { cn } from '../../lib/utils.js'

interface TabItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

/**
 * Mobile bottom navigation tab bar conforming to WCAG / iOS touch ergonomics.
 * Provides fixed 48px+ touch targets for the 5 primary workspace areas.
 */
export function MobileTabBar() {
  const session = useSession()
  const isAdmin = isAdminRole(session.data?.role)
  const location = useLocation()

  const tabs: TabItem[] = [
    { to: '/', label: 'Graph', icon: Waypoints, end: true },
    { to: '/vaults', label: 'Vaults', icon: Library },
    { to: '/repos', label: 'Repos', icon: GitBranch },
    isAdmin
      ? { to: '/admin', label: 'Admin', icon: ShieldCheck }
      : { to: '/team', label: 'Team', icon: Users },
    { to: '/settings', label: 'Settings', icon: Settings2 },
  ]

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed bottom-0 inset-x-0 z-30 flex h-16 pb-safe items-center justify-around border-t border-border bg-card/95 backdrop-blur-md select-none md:hidden"
    >
      {tabs.map((tab) => {
        const Icon = tab.icon
        const isActive = tab.end
          ? location.pathname === tab.to
          : location.pathname === tab.to || location.pathname.startsWith(`${tab.to}/`)

        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            aria-label={tab.label}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center justify-center py-1.5 min-h-[48px] text-muted-foreground outline-none transition-all duration-150',
              'hover:text-foreground active:scale-95',
              'focus-visible:ring-2 focus-visible:ring-ring/40',
              isActive && 'text-primary font-semibold',
            )}
          >
            <div className="relative flex items-center justify-center">
              <Icon
                className={cn('size-5 transition-transform duration-150', isActive && 'scale-110 text-primary')}
                strokeWidth={isActive ? 2.25 : 1.75}
                aria-hidden="true"
              />
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute -bottom-1 size-1 rounded-full bg-primary"
                />
              )}
            </div>
            <span
              className={cn(
                'mt-1 text-[11px] tracking-tight leading-none',
                isActive ? 'text-primary font-semibold' : 'text-muted-foreground',
              )}
            >
              {tab.label}
            </span>
          </NavLink>
        )
      })}
    </nav>
  )
}
