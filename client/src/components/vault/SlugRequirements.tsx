import { Check, X } from 'lucide-react'
import { cn } from '../../lib/utils.js'

export const SLUG = /^[a-z0-9][a-z0-9-]*$/

export interface SlugRequirementsProps {
  value: string
  className?: string
}

export function SlugRequirements({ value, className }: SlugRequirementsProps) {
  if (!value) return null
  const startsValid = /^[a-z0-9]/.test(value)
  const charsValid = /^[a-z0-9-]*$/.test(value)

  return (
    <div className={cn('mt-1 flex flex-col gap-1 text-[11px]', className)} role="status" aria-live="polite">
      <div
        className={cn(
          'flex items-center gap-1.5 transition-colors',
          startsValid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400',
        )}
      >
        {startsValid ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
        <span>Starts with a lowercase letter or number</span>
      </div>
      <div
        className={cn(
          'flex items-center gap-1.5 transition-colors',
          charsValid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400',
        )}
      >
        {charsValid ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
        <span>Lowercase letters, numbers, and hyphens only</span>
      </div>
    </div>
  )
}
