import { useState, type ReactNode } from 'react'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { cn } from '../../lib/utils.js'

interface ConfirmStepProps {
  /** The committing button's text, e.g. "Revoke". */
  label: string
  /** What happens to whom, in plain language. */
  consequence: ReactNode
  onConfirm: () => void
  onCancel: () => void
  pending?: boolean
  error?: string | null
  destructive?: boolean
}

/**
 * The consequence step of an inline confirmation: the copy in plain language,
 * then the committing button (destructive-styled when the action takes
 * something away) and Cancel. Shared by ConfirmAction and the MFA requirement
 * switch, whose resting control is a Switch rather than a button.
 */
export function ConfirmStep({
  label,
  consequence,
  onConfirm,
  onCancel,
  pending = false,
  error = null,
  destructive = false,
}: ConfirmStepProps) {
  return (
    <div
      className={cn(
        'flex max-w-md min-w-56 flex-col gap-1.5 rounded-md border p-2 text-left whitespace-normal',
        destructive ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-muted/40',
      )}
    >
      <p className="text-xs text-muted-foreground">{consequence}</p>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="xs"
          variant={destructive ? 'destructive' : 'default'}
          disabled={pending}
          onClick={onConfirm}
        >
          {label}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <FormError message={error} />
    </div>
  )
}

interface ConfirmActionProps {
  /** The resting button's text, e.g. "Revoke". */
  label: string
  /**
   * What happens to whom, in plain language. The design system forbids a bare
   * "Are you sure?" — every admin action here reaches someone else's access.
   */
  consequence: ReactNode
  /** Distinguishes the resting button from every other one in the table. */
  ariaLabel: string
  onConfirm: () => void
  pending?: boolean
  error?: string | null
  destructive?: boolean
}

/**
 * Button → inline consequence → confirm. Five admin actions need exactly this
 * (approve is the one that doesn't — it grants rather than takes away), so it
 * lives here instead of five times over.
 */
export function ConfirmAction({
  label,
  consequence,
  ariaLabel,
  onConfirm,
  pending = false,
  error = null,
  destructive = false,
}: ConfirmActionProps) {
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={ariaLabel}
        onClick={() => setConfirming(true)}
      >
        {label}
      </Button>
    )
  }

  return (
    <ConfirmStep
      label={label}
      consequence={consequence}
      destructive={destructive}
      pending={pending}
      error={error}
      onConfirm={onConfirm}
      onCancel={() => setConfirming(false)}
    />
  )
}
