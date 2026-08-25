import { FormError } from '../FormError.js'
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from '../../hooks/useAccount.js'

/**
 * One switch, not a matrix. Per-type preferences and digests are explicitly
 * out of scope in `2026-07-15-notifications-activity-feed-design.md`, and the
 * in-app feed is deliberately not switchable at all: it is the historical
 * record the notifications spec depends on, not a toast queue. So the only
 * thing there is to decide is whether that record also reaches your inbox —
 * and the copy has to say that, or turning it off reads like turning
 * notifications off.
 */
export function NotificationPreferences() {
  const prefs = useNotificationPreferences()
  const update = useUpdateNotificationPreferences()

  if (prefs.isPending) {
    return <p className="text-sm text-muted-foreground">Loading your notification preferences…</p>
  }
  if (prefs.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {prefs.error.message}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <label className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted">
        <input
          type="checkbox"
          className="mt-1"
          checked={prefs.data.emailNotifications}
          disabled={update.isPending}
          onChange={(e) => update.mutate({ emailNotifications: e.target.checked })}
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm text-foreground">Email me about notifications</span>
          <span className="text-xs text-muted-foreground">
            Turning this off stops the emails and nothing else. The notification bell keeps recording
            every mention, share and change either way — you read them here instead of in your inbox,
            and nothing goes missing while it is off.
          </span>
        </span>
      </label>
      {/* A failed write leaves the box where it was, which on its own looks
          like the click did nothing. Say why. */}
      <FormError message={update.error?.message ?? null} />
    </div>
  )
}
