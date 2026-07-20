import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Button } from '../components/ui/button.js'
import { useSession, SESSION_QUERY_KEY } from '../hooks/useSession.js'
import { logout } from '../api/auth.js'

export function HomePage() {
  const session = useSession()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    navigate('/login')
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-8 py-4">
        <span className="font-display text-xl">Chapters</span>
        {session.data && (
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{session.data.email}</span>
            <Button variant="secondary" onClick={() => void handleLogout()}>
              Log out
            </Button>
          </div>
        )}
      </header>
      <main className="flex-1 p-8">
        <p className="text-muted-foreground">The rest of Chapters is under construction.</p>
      </main>
    </div>
  )
}
