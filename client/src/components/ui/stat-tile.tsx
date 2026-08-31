import * as React from 'react'
import { cn } from '@/lib/utils'
import { Eyebrow } from './eyebrow'

const numberFormatter = new Intl.NumberFormat('en-US')

/** A labelled number. Mono numerals so columns of tiles line up. */
function StatTile({
  label,
  value,
  hint,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  label: React.ReactNode
  value: number | string
  hint?: React.ReactNode
}) {
  const rendered =
    typeof value === 'number' ? numberFormatter.format(value) : value
  return (
    <div
      data-slot="stat-tile"
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-md border border-border bg-card px-3 py-2.5',
        className,
      )}
      {...props}
    >
      <Eyebrow>{label}</Eyebrow>
      <span className="font-mono text-xl leading-none font-medium tabular-nums text-foreground">
        {rendered}
      </span>
      {hint !== undefined && (
        <span className="text-xs text-muted-foreground">{hint}</span>
      )}
    </div>
  )
}

export { StatTile }
