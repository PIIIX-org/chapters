import * as React from 'react'
import { cn } from '@/lib/utils'
import { Eyebrow } from './eyebrow'

/**
 * The console's bordered surface: an eyebrow title row with optional actions,
 * then a body. Nothing inside it may float; if a panel needs more room it
 * scrolls its own body.
 */
function Panel({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="panel"
      className={cn(
        'flex min-w-0 flex-col rounded-md border border-border bg-card text-card-foreground',
        className,
      )}
      {...props}
    />
  )
}

function PanelHeader({
  className,
  title,
  titleAs = 'h2',
  actions,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  title?: React.ReactNode
  titleAs?: 'h2' | 'h3' | 'div'
  actions?: React.ReactNode
}) {
  return (
    <div
      data-slot="panel-header"
      className={cn(
        'flex h-9 shrink-0 items-center gap-2 border-b border-border px-3',
        className,
      )}
      {...props}
    >
      {title !== undefined && (
        <Eyebrow as={titleAs} className="min-w-0 flex-1 truncate">
          {title}
        </Eyebrow>
      )}
      {children}
      {actions && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {actions}
        </div>
      )}
    </div>
  )
}

function PanelBody({
  className,
  dense = false,
  ...props
}: React.ComponentProps<'div'> & { dense?: boolean }) {
  return (
    <div
      data-slot="panel-body"
      className={cn('min-h-0 flex-1', dense ? 'p-2' : 'p-3', className)}
      {...props}
    />
  )
}

function PanelFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="panel-footer"
      className={cn(
        'flex shrink-0 items-center gap-2 border-t border-border px-3 py-2',
        className,
      )}
      {...props}
    />
  )
}

export { Panel, PanelHeader, PanelBody, PanelFooter }
