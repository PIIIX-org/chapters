import * as React from 'react'
import { cn } from '@/lib/utils'

/** Opacity-only pulse; disabled entirely under prefers-reduced-motion (index.css). */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn('animate-pulse rounded-sm bg-muted', className)}
      {...props}
    />
  )
}

export { Skeleton }
