import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { useAdminUsers, useApproveUser } from '../../hooks/useAdmin.js'

const joined = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

function formatDate(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : joined.format(parsed)
}

/**
 * The onboarding bottleneck. Signup leaves an account `pending_approval` with
 * no verified email, and login (`auth/routes.ts:169`) requires both — so until
 * an admin acts here, a new person cannot get in at all.
 */
export function ApprovalQueue() {
  const pending = useAdminUsers('pending_approval')
  const approve = useApproveUser()

  if (pending.isPending) return <p className="text-sm text-muted-foreground">Loading the queue…</p>
  if (pending.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {pending.error.message}
      </p>
    )
  }

  if (pending.data.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">
          Nobody is waiting. New sign-ups land here — they cannot log in until you approve them.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <FormError message={approve.error?.message ?? null} />
      <ul className="flex flex-col gap-2">
        {pending.data.map((user) => (
          <li
            key={user.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-foreground">{user.email}</span>
              <span className="font-mono text-xs text-muted-foreground">
                Signed up {formatDate(user.createdAt)}
              </span>
              {/* Approving alone is not enough: the login gate needs a verified
                  email too, so an admin who approves this row and hears nothing
                  back would otherwise have no way to know why. */}
              {!user.emailVerifiedAt && (
                <span className="text-xs text-muted-foreground">
                  Email not verified yet — approving now is fine, but they still can&rsquo;t sign in until they
                  enter the code sent to their address.
                </span>
              )}
            </div>
            <Button
              type="button"
              size="xs"
              aria-label={`Approve ${user.email}`}
              disabled={approve.isPending}
              onClick={() => approve.mutate(user.id)}
            >
              Approve
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
