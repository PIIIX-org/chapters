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
import {
  useAdminUsers,
  useDeactivateUser,
  useDemoteUser,
  usePromoteUser,
  useUpdateUserRole,
} from '../../hooks/useAdmin.js'
import { useSession } from '../../hooks/useSession.js'
import {
  ROLE_LABELS,
  USER_ROLES,
  isAdminRole,
  type AdminUser,
  type UserRole,
} from '../../api/admin.js'

const STATUS_TONE: Record<AdminUser['status'], PillTone> = {
  active: 'live',
  pending_approval: 'idle',
  deactivated: 'neutral',
}

const ROLE_TONE: Record<UserRole, PillTone> = {
  owner: 'human',
  superadmin: 'human',
  admin: 'human',
  moderator: 'live',
  manager: 'live',
  editor: 'idle',
  contributor: 'idle',
  member: 'neutral',
  viewer: 'neutral',
  guest: 'neutral',
}

/**
 * Every account on the instance, with granular permission levels (owner,
 * admin, moderator, manager, editor, contributor, member, viewer, guest)
 * and levers: promote to admin, demote to member, change role, and deactivate.
 */
export function UserRoster() {
  const users = useAdminUsers()
  const session = useSession()
  const promote = usePromoteUser()
  const demote = useDemoteUser()
  const updateRole = useUpdateUserRole()
  const deactivate = useDeactivateUser()

  return (
    <Panel className="rounded-[var(--radius-sm,2px)]">
      <PanelHeader title="People" />
      {users.isPending ? (
        <PanelState status="loading" compact message="Loading users…" />
      ) : users.isError ? (
        <PanelState status="error" compact message={users.error.message} />
      ) : (
        <Table className="rounded-[var(--radius-sm,2px)]">
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
              // Deactivating or demoting yourself would destroy your own session and, on a
              // single-admin instance, lock the instance out of its own admin
              // area. The server has no such guard, so it belongs here.
              const isSelf = user.id === session.data?.id
              return (
                <TableRow key={user.id}>
                  <TableCell className="py-2.5 align-top text-foreground">
                    {user.email}
                  </TableCell>
                  <TableCell className="py-2 align-top">
                    <Pill tone={STATUS_TONE[user.status]} dot className="rounded-[var(--radius-sm,2px)] font-mono text-[11px]">
                      {user.status.replace('_', ' ')}
                    </Pill>
                    {!user.emailVerifiedAt && (
                      <span className="mt-1 block font-mono text-[11px] text-faint">
                        email unverified
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-2 align-top">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill tone={ROLE_TONE[user.role] ?? 'neutral'} className="rounded-[var(--radius-sm,2px)] font-mono text-[11px] uppercase tracking-[0.04em]">
                        {ROLE_LABELS[user.role] ?? user.role}
                      </Pill>
                      {!isSelf && user.status === 'active' && (
                        <select
                          aria-label={`Change role for ${user.email}`}
                          value={user.role}
                          disabled={updateRole.isPending}
                          onChange={(e) =>
                            updateRole.mutate({
                              id: user.id,
                              role: e.target.value as UserRole,
                            })
                          }
                          className="text-xs bg-muted/60 border border-border/80 rounded-[var(--radius-sm,2px)] px-1.5 py-0.5 text-foreground hover:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer font-mono"
                        >
                          {USER_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="py-2 align-top">
                    <div className="flex flex-wrap items-center gap-1 whitespace-normal">
                      {!isAdminRole(user.role) && user.status === 'active' && (
                        <ConfirmAction
                          label="Promote"
                          ariaLabel={`Promote ${user.email} to admin`}
                          consequence={`${user.email} gets administrative privileges: the approval queue, every oversight table, force-revoke, and the instance backup.`}
                          pending={promote.isPending}
                          error={promote.error?.message ?? null}
                          onConfirm={() => promote.mutate({ id: user.id, role: 'admin' })}
                        />
                      )}
                      {isAdminRole(user.role) && !isSelf && user.status === 'active' && (
                        <ConfirmAction
                          label="Demote"
                          destructive
                          ariaLabel={`Demote ${user.email}`}
                          consequence={`${user.email} will lose administrative privileges and be demoted to member.`}
                          pending={demote.isPending}
                          error={demote.error?.message ?? null}
                          onConfirm={() => demote.mutate({ id: user.id, role: 'member' })}
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
