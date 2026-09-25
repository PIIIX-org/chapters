import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { CircleUser, LogOut, Settings2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js'
import { SESSION_QUERY_KEY, useSession } from '../../hooks/useSession.js'
import { useTheme } from '../../hooks/useTheme.js'
import { logout } from '../../api/auth.js'
import { isThemePreference } from '../../lib/theme.js'
import { cn } from '../../lib/utils.js'

export function AccountMenu({ showLabel = false }: { showLabel?: boolean } = {}) {
  const session = useSession()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const theme = useTheme()

  async function handleLogout() {
    await logout()
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    navigate('/login')
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className={cn(
            'relative flex items-center justify-center rounded-[var(--radius-md)] text-muted-foreground outline-none transition-all duration-150 hover:bg-muted hover:text-foreground active:scale-95 active:bg-muted/80 focus-visible:ring-2 focus-visible:ring-ring/40',
            showLabel
              ? 'h-9 w-full justify-start gap-2.5 px-2.5 text-[13px] font-medium'
              : 'h-9 w-full justify-center p-0 hover:scale-105',
          )}
        >
          <CircleUser className="size-[18px] shrink-0" aria-hidden="true" />
          {showLabel && <span className="truncate">Profile</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        <DropdownMenuLabel className="truncate font-sans text-xs normal-case tracking-normal text-foreground">
          {session.data?.email ?? 'Signed in'}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme.preference}
          onValueChange={(value) => {
            if (isThemePreference(value)) theme.setPreference(value)
          }}
        >
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings2 aria-hidden="true" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void handleLogout()}>
          <LogOut aria-hidden="true" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
