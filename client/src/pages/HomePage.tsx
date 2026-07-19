import { useSession } from '../hooks/useSession.js'

export function HomePage() {
  const session = useSession()

  return (
    <div className="p-8">
      <p className="font-display text-2xl">Chapters</p>
      {session.data && <p className="text-muted-foreground">{session.data.email}</p>}
    </div>
  )
}
