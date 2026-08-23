import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Button } from '../ui/button.js'
import { useSession, SESSION_QUERY_KEY } from '../../hooks/useSession.js'
import { logout } from '../../api/auth.js'
import { ScopePicker } from './ScopePicker.js'

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    navigate('/login')
  }

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-background">
      <div className="absolute inset-0">{children}</div>

      <div className="absolute left-4 top-4">
        <ScopePicker />
      </div>

      <div className="absolute right-4 top-4 flex items-center gap-2">
        {/* ponytail: empty until unit 1e wires the notification bell + drawer */}
        <div data-slot="notifications" />
        {session.data && (
          <>
            <span className="text-sm text-muted-foreground">{session.data.email}</span>
            <Button variant="secondary" onClick={() => void handleLogout()}>
              Log out
            </Button>
          </>
        )}
      </div>

      {/* ponytail: bottom-left is reserved for the hosted "Sky" button; OSS renders nothing here */}
    </div>
  )
}
