import * as React from 'react'
import { cn } from '@/lib/utils'
import { Button } from './button'

/**
 * One component for the three states a data panel can be in that are not
 * "content": loading, error (with retry), empty (with an optional action).
 * `role="alert"` only on error; loading is `role="status"`.
 */
function PanelState({
  status,
  title,
  message,
  onRetry,
  action,
  className,
  compact = false,
}: {
  status: 'loading' | 'error' | 'empty'
  title?: React.ReactNode
  message?: React.ReactNode
  onRetry?: () => void
  action?: React.ReactNode
  className?: string
  compact?: boolean
}) {
  const role =
    status === 'error' ? 'alert' : status === 'loading' ? 'status' : undefined
  return (
    <div
      role={role}
      data-slot="panel-state"
      data-status={status}
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact ? 'px-3 py-4' : 'px-6 py-10',
        className,
      )}
    >
      {title !== undefined && (
        <p
          className={cn(
            'font-medium text-foreground',
            compact ? 'text-sm' : 'text-base',
          )}
        >
          {title}
        </p>
      )}
      {message !== undefined && (
        <p
          className={cn(
            'max-w-sm text-muted-foreground',
            compact ? 'text-xs' : 'text-sm',
          )}
        >
          {message}
        </p>
      )}
      {status === 'loading' && title === undefined && message === undefined && (
        <span className="text-xs text-muted-foreground">Loading…</span>
      )}
      {(onRetry || action) && (
        <div className="mt-1 flex items-center gap-2">
          {onRetry && (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  )
}

export { PanelState }
