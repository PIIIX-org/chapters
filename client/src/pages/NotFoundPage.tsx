import { Link } from 'react-router'
import { Compass, Home, Library, GitBranch } from 'lucide-react'
import { Button } from '../components/ui/button.js'

export function NotFoundPage() {
  return (
    <div className="flex h-full min-h-[500px] w-full items-center justify-center p-6 text-foreground">
      <div className="flex max-w-md w-full flex-col items-center text-center">
        <div className="mb-4 flex size-14 items-center justify-center rounded-2xl border border-sky-500/20 bg-sky-500/10 text-sky-400 shadow-floating">
          <Compass className="size-7" aria-hidden="true" />
        </div>

        <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Error 404
        </span>

        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Waypoint Unreachable
        </h1>

        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          The celestial coordinates for this waypoint do not exist in the knowledge matrix or have
          been shifted to another sector.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button asChild variant="default" size="sm">
            <Link to="/">
              <Home className="size-3.5 mr-1.5" aria-hidden="true" />
              Observatory Home
            </Link>
          </Button>

          <Button asChild variant="outline" size="sm">
            <Link to="/vaults">
              <Library className="size-3.5 mr-1.5" aria-hidden="true" />
              Browse Vaults
            </Link>
          </Button>

          <Button asChild variant="ghost" size="sm">
            <Link to="/repos">
              <GitBranch className="size-3.5 mr-1.5" aria-hidden="true" />
              Repositories
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
