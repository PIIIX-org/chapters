import { ConfirmAction } from './ConfirmAction.js'
import { PanelState } from '../ui/empty-state.js'
import { Panel, PanelHeader } from '../ui/panel.js'
import { Pill, type PillTone } from '../ui/pill.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js'
import { useAdminUsers, useDeactivateUser, usePromoteUser } from '../../hooks/useAdmin.js'
import { useSession } from '../../hooks/useSession.js'
import type { AdminUser } from '../../api/admin.js'

const STATUS_TONE: Record<AdminUser['status'], PillTone> = {
  active: 'live',
  pending_approval: 'idle',
  deactivated: 'neutral',
}

/**
 * Every account on the instance, with the two structural levers from the
 * oversight spec: promote to admin, deactivate. Neither reads any content.
 */
export function UserRoster() {
  const users = useAdminUsers()
  const session = useSession()
  const promote = usePromoteUser()
  const deactivate = useDeactivateUser()

  return (
    <Panel>
      <PanelHeader title="People" />
      {users.isPending ? (
        <PanelState status="loading" compact message="Loading users…" />
      ) : users.isError ? (
        <PanelState status="error" compact message={users.error.message} />
      ) : (
        <Table>
          <caption className="sr-only">Every account on this instance</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Account</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Role</TableHead>
              <TableHead scope="col">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.data.map((user) => {
              // Deactivating yourself would destroy your own session and, on a
              // single-admin instance, lock the instance out of its own admin
              // area. The server has no such guard, so it belongs here.
              const isSelf = user.id === session.data?.id
              return (
                <TableRow key={user.id}>
                  <TableCell className="py-2.5 align-top text-foreground">
                    {user.email}
                  </TableCell>
                  <TableCell className="py-2 align-top">
                    <Pill tone={STATUS_TONE[user.status]} dot>
                      {user.status.replace('_', ' ')}
                    </Pill>
                    {!user.emailVerifiedAt && (
                      <span className="mt-1 block font-mono text-[11px] text-faint">
                        email unverified
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-2 align-top">
                    <Pill tone={user.role === 'admin' ? 'human' : 'neutral'}>
                      {user.role}
                    </Pill>
                  </TableCell>
                  <TableCell className="py-2 align-top">
                    <div className="flex flex-wrap items-center gap-1 whitespace-normal">
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
                      {isSelf && (
                        <span className="text-xs text-muted-foreground">
                          This is you
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}
