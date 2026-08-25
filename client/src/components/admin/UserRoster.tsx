import { ConfirmAction } from './ConfirmAction.js'
import { useAdminUsers, useDeactivateUser, usePromoteUser } from '../../hooks/useAdmin.js'
import { useSession } from '../../hooks/useSession.js'

/**
 * Every account on the instance, with the two structural levers from the
 * oversight spec: promote to admin, deactivate. Neither reads any content.
 */
export function UserRoster() {
  const users = useAdminUsers()
  const session = useSession()
  const promote = usePromoteUser()
  const deactivate = useDeactivateUser()

  if (users.isPending) return <p className="text-sm text-muted-foreground">Loading users…</p>
  if (users.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {users.error.message}
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Every account on this instance</caption>
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-normal">
              Account
            </th>
            <th scope="col" className="py-2 pr-4 font-normal">
              Status
            </th>
            <th scope="col" className="py-2 pr-4 font-normal">
              Role
            </th>
            <th scope="col" className="py-2 font-normal">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {users.data.map((user) => {
            // Deactivating yourself would destroy your own session and, on a
            // single-admin instance, lock the instance out of its own admin
            // area. The server has no such guard, so it belongs here.
            const isSelf = user.id === session.data?.id
            return (
              <tr key={user.id} className="border-b border-border align-top">
                <td className="py-2 pr-4 text-foreground">{user.email}</td>
                <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                  {user.status.replace('_', ' ')}
                  {!user.emailVerifiedAt && <span className="block">email unverified</span>}
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{user.role}</td>
                <td className="flex flex-wrap gap-1 py-2">
                  {user.role !== 'admin' && user.status === 'active' && (
                    <ConfirmAction
                      label="Promote"
                      ariaLabel={`Promote ${user.email} to admin`}
                      consequence={`${user.email} gets the whole admin area: the approval queue, every oversight table, force-revoke, and the instance backup. It cannot be undone from here.`}
                      pending={promote.isPending}
                      error={promote.error?.message ?? null}
                      onConfirm={() => promote.mutate(user.id)}
                    />
                  )}
                  {user.status !== 'deactivated' && !isSelf && (
                    <ConfirmAction
                      label="Deactivate"
                      destructive
                      ariaLabel={`Deactivate ${user.email}`}
                      consequence={`${user.email} is signed out everywhere, dropped from every team, and every vault shared directly with them is unshared. Vaults they own stay put — reassign those first if someone else needs them.`}
                      pending={deactivate.isPending}
                      error={deactivate.error?.message ?? null}
                      onConfirm={() => deactivate.mutate(user.id)}
                    />
                  )}
                  {isSelf && <span className="text-xs text-muted-foreground">This is you</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
