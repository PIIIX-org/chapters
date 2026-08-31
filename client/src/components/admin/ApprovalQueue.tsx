import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { PanelState } from '../ui/empty-state.js'
import { Panel, PanelHeader } from '../ui/panel.js'
import { Pill } from '../ui/pill.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js'
import { useAdminUsers, useApproveUser } from '../../hooks/useAdmin.js'

const joined = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

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

  return (
    <Panel>
      <PanelHeader title="Approvals" />
      {pending.isPending ? (
        <PanelState status="loading" compact message="Loading the queue…" />
      ) : pending.isError ? (
        <PanelState status="error" compact message={pending.error.message} />
      ) : pending.data.length === 0 ? (
        <PanelState
          status="empty"
          title="Nobody is waiting."
          message="New sign-ups land here — they cannot log in until you approve them."
        />
      ) : (
        <>
          {approve.error && (
            <div className="border-b border-border px-3 py-2">
              <FormError message={approve.error.message} />
            </div>
          )}
          <Table>
            <caption className="sr-only">
              Accounts waiting for approval on this instance
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Account</TableHead>
                <TableHead scope="col">Signed up</TableHead>
                <TableHead scope="col">Email</TableHead>
                <TableHead scope="col" className="text-right">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.data.map((user) => (
                <TableRow key={user.id} className="align-top">
                  <TableCell className="py-2.5 align-top text-foreground">
                    {user.email}
                    {/* Approving alone is not enough: the login gate needs a
                        verified email too, so an admin who approves this row
                        and hears nothing back would otherwise have no way to
                        know why. */}
                    {!user.emailVerifiedAt && (
                      <p className="mt-1 max-w-md text-xs whitespace-normal text-muted-foreground">
                        Email not verified yet — approving now is fine, but
                        they still can&rsquo;t sign in until they enter the
                        code sent to their address.
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="py-2.5 align-top font-mono text-xs text-muted-foreground">
                    {formatDate(user.createdAt)}
                  </TableCell>
                  <TableCell className="py-2.5 align-top">
                    {user.emailVerifiedAt ? (
                      <Pill tone="live" dot>
                        Verified
                      </Pill>
                    ) : (
                      <Pill tone="idle" dot>
                        Unverified
                      </Pill>
                    )}
                  </TableCell>
                  <TableCell className="py-2 align-top text-right">
                    <Button
                      type="button"
                      size="xs"
                      aria-label={`Approve ${user.email}`}
                      disabled={approve.isPending}
                      onClick={() => approve.mutate(user.id)}
                    >
                      Approve
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </Panel>
  )
}
