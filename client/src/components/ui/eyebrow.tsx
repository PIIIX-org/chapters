import * as React from 'react'
import { cn } from '@/lib/utils'

type EyebrowTag = 'span' | 'h2' | 'h3' | 'div' | 'p'

/** Tracked mono label — the console's section titles and field names. */
function Eyebrow({
  className,
  as = 'span',
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: EyebrowTag }) {
  const Comp: React.ElementType = as
  return (
    <Comp
      data-slot="eyebrow"
      className={cn(
        'font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Eyebrow }
