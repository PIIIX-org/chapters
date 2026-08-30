import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { CircleUser, LogOut, Settings2 } from 'lucide-react'
import { Button } from '../ui/button.js'
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

export function AccountMenu() {
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Account menu"
        >
          <CircleUser aria-hidden="true" />
        </Button>
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
