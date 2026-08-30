import * as React from 'react'
import type { VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { pillVariants } from './pill-variants'

export type PillTone = NonNullable<VariantProps<typeof pillVariants>['tone']>

const dotColor: Record<PillTone, string> = {
  neutral: 'bg-muted-foreground',
  live: 'bg-success',
  idle: 'bg-warning',
  error: 'bg-destructive',
  human: 'bg-primary',
  ai: 'bg-accent',
}

function StatusDot({
  tone = 'neutral',
  className,
}: {
  tone?: PillTone
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="status-dot"
      className={cn('size-1.5 rounded-full', dotColor[tone], className)}
    />
  )
}

function Pill({
  className,
  tone = 'neutral',
  dot = false,
  children,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof pillVariants> & { dot?: boolean }) {
  return (
    <span
      data-slot="pill"
      data-tone={tone}
      className={cn(pillVariants({ tone }), className)}
      {...props}
    >
      {dot && <StatusDot tone={tone ?? 'neutral'} />}
      {children}
    </span>
  )
}

export { Pill, StatusDot }
