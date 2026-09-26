import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { isRouteErrorResponse, useRouteError, Link } from 'react-router'
import { AlertTriangle, RotateCcw, Home, ChevronDown, ChevronRight, Compass } from 'lucide-react'
import { Button } from './ui/button.js'

interface ErrorBoundaryProps {
  children?: ReactNode
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode)
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary caught crash]:', error, errorInfo)
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  override render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error, this.reset)
      }
      if (this.props.fallback) {
        return this.props.fallback
      }
      return <ErrorFallback error={this.state.error} onReset={this.reset} />
    }

    return this.props.children
  }
}

/**
 * Route-level error boundary used as `errorElement` in React Router.
 * Handles both HTTP RouteErrorResponses (404, 403, 500) and unhandled component throws.
 */
export function RouteErrorBoundary() {
  const error = useRouteError()

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return (
        <div className="flex h-dvh w-full items-center justify-center bg-background p-6 text-foreground">
          <div className="flex max-w-md flex-col items-center text-center">
            <div className="mb-4 flex size-14 items-center justify-center rounded-2xl border border-sky-500/20 bg-sky-500/10 text-sky-400 shadow-floating">
              <Compass className="size-7" aria-hidden="true" />
            </div>
            <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Status 404
            </span>
            <h1 className="mt-1 text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Waypoint Unreachable
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {error.statusText ||
                'The celestial coordinates for this route do not exist or have been shifted.'}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button asChild variant="default" size="sm">
                <Link to="/">
                  <Home className="size-3.5 mr-1.5" aria-hidden="true" />
                  Observatory Home
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to="/vaults">Browse Vaults</Link>
              </Button>
            </div>
          </div>
        </div>
      )
    }

    if (error.status === 403) {
      return (
        <div className="flex h-dvh w-full items-center justify-center bg-background p-6 text-foreground">
          <div className="flex max-w-md flex-col items-center text-center">
            <div className="mb-4 flex size-14 items-center justify-center rounded-2xl border border-amber-500/20 bg-amber-500/10 text-amber-400 shadow-floating">
              <AlertTriangle className="size-7" aria-hidden="true" />
            </div>
            <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Status 403
            </span>
            <h1 className="mt-1 text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Access Restricted
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              You do not have permission to view this sector or resource.
            </p>
            <div className="mt-6 flex gap-3">
              <Button asChild variant="default" size="sm">
                <Link to="/">Observatory Home</Link>
              </Button>
            </div>
          </div>
        </div>
      )
    }
  }

  const err = error instanceof Error ? error : new Error(String(error))
  return <ErrorFallback error={err} />
}

export function ErrorFallback({
  error,
  onReset,
}: {
  error: Error
  onReset?: () => void
}) {
  const [showDetails, setShowDetails] = useState(false)

  return (
    <div
      role="alert"
      className="flex min-h-[400px] h-full w-full items-center justify-center bg-background p-6 text-foreground"
    >
      <div className="flex max-w-lg w-full flex-col items-center rounded-2xl border border-red-500/20 bg-card/90 p-8 text-center shadow-floating backdrop-blur-md">
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 shadow-sm">
          <AlertTriangle className="size-6" aria-hidden="true" />
        </div>

        <span className="text-[11px] font-mono uppercase tracking-widest text-red-400/90">
          Observatory Anomaly
        </span>
        <h2 className="mt-1.5 text-xl font-bold tracking-tight text-foreground">
          Something interrupted this view
        </h2>
        <p className="mt-2 text-xs sm:text-sm text-muted-foreground leading-relaxed">
          An unexpected interface error occurred. Your notes, vault data, and edits remain safely
          persisted on the server.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => {
              if (onReset) onReset()
              else window.location.reload()
            }}
          >
            <RotateCcw className="size-3.5 mr-1.5" aria-hidden="true" />
            Reload View
          </Button>

          <Button asChild variant="outline" size="sm">
            <Link to="/">
              <Home className="size-3.5 mr-1.5" aria-hidden="true" />
              Return Home
            </Link>
          </Button>
        </div>

        {/* Collapsible Diagnostics */}
        <div className="mt-6 w-full text-left">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground transition-colors hover:text-foreground"
          >
            {showDetails ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden="true" />
            )}
            Telemetry Diagnostics
          </button>

          {showDetails ? (
            <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-left font-mono text-[11px] text-muted-foreground">
              <p className="font-semibold text-red-400">{error.name}: {error.message}</p>
              {error.stack ? (
                <pre className="mt-2 whitespace-pre-wrap break-all text-[10px] leading-tight text-muted-foreground/80">
                  {error.stack}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
