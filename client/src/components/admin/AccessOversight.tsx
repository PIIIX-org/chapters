import { ConfirmAction } from './ConfirmAction.js'
import {
  useAdminMcpConnections,
  useAdminShares,
  useAdminTeams,
  useAdminUsers,
  useAdminVaults,
  useForceRevokeMcpConnection,
  useForceRevokeShare,
} from '../../hooks/useAdmin.js'

const stamp = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function formatStamp(iso: string | null): string {
  if (!iso) return 'never'
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? 'never' : stamp.format(parsed)
}

/**
 * The incident-response levers. Both actions are structural: they remove
 * someone's reach into a vault. Neither grants the admin any read.
 *
 * Share rows arrive as ids. The vault, user and team lists are already loaded
 * for the other admin views, so the names are joined here rather than behind a
 * new endpoint — an admin table full of UUIDs is not an oversight tool.
 */
export function AccessOversight() {
  const shares = useAdminShares()
  const vaults = useAdminVaults()
  const users = useAdminUsers()
  const teams = useAdminTeams()
  const connections = useAdminMcpConnections()
  const revokeShare = useForceRevokeShare()
  const revokeConnection = useForceRevokeMcpConnection()

  const vaultName = new Map((vaults.data ?? []).map((v) => [v.id, v.name]))
  const userEmail = new Map((users.data ?? []).map((u) => [u.id, u.email]))
  const teamName = new Map((teams.data ?? []).map((t) => [t.id, t.name]))

  function granteeLabel(type: 'user' | 'team', id: string): string {
    const found = type === 'user' ? userEmail.get(id) : teamName.get(id)
    // A share can outlive the row it points at (a team deleted out from under
    // it, say). Falling through to a blank cell would hide a live grant.
    return found ?? `${type} no longer on this instance`
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h3 className="font-display text-lg text-foreground">Shares</h3>
        <p className="text-sm text-muted-foreground">
          Every grant on the instance. Revoking one cuts that person or team off the vault immediately — access is
          re-checked on every request, so there is no session to wait out.
        </p>
        {shares.isPending ? (
          <p className="text-sm text-muted-foreground">Loading shares…</p>
        ) : shares.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {shares.error.message}
          </p>
        ) : shares.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is shared on this instance yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Every vault share on this instance</caption>
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Vault
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Shared with
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Permission
                  </th>
                  <th scope="col" className="py-2 font-normal">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {shares.data.map((share) => {
                  const vault = vaultName.get(share.vaultId) ?? 'deleted vault'
                  const grantee = granteeLabel(share.granteeType, share.granteeId)
                  return (
                    <tr key={share.id} className="border-b border-border align-top">
                      <td className="py-2 pr-4 text-foreground">{vault}</td>
                      <td className="py-2 pr-4 text-foreground">
                        {grantee}
                        <span className="ml-1 font-mono text-xs text-muted-foreground">{share.granteeType}</span>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{share.permission}</td>
                      <td className="py-2">
                        <ConfirmAction
                          label="Revoke"
                          destructive
                          ariaLabel={`Revoke ${grantee}'s access to ${vault}`}
                          consequence={`${grantee} loses access to "${vault}" on their very next request. Any note they have open stops saving. The owner can share it again afterwards.`}
                          pending={revokeShare.isPending}
                          error={revokeShare.error?.message ?? null}
                          onConfirm={() => revokeShare.mutate(share.id)}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-display text-lg text-foreground">MCP connections</h3>
        <p className="text-sm text-muted-foreground">
          Tokens AI clients use to reach this instance. Revoking one kills that token only — the account keeps
          working, which is the point of having this next to Deactivate rather than instead of it.
        </p>
        {connections.isPending ? (
          <p className="text-sm text-muted-foreground">Loading connections…</p>
        ) : connections.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {connections.error.message}
          </p>
        ) : connections.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No MCP connections on this instance yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Every MCP connection on this instance</caption>
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Connection
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Account
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Scope
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Last used
                  </th>
                  <th scope="col" className="py-2 font-normal">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {connections.data.map((connection) => (
                  <tr key={connection.id} className="border-b border-border align-top">
                    <td className="py-2 pr-4 text-foreground">{connection.name}</td>
                    <td className="py-2 pr-4 text-foreground">{connection.userEmail}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {connection.scope}
                      {connection.vaultId && (
                        <span className="block">{vaultName.get(connection.vaultId) ?? 'deleted vault'}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {formatStamp(connection.lastUsedAt)}
                    </td>
                    <td className="py-2">
                      {connection.revokedAt ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          revoked {formatStamp(connection.revokedAt)}
                        </span>
                      ) : (
                        <ConfirmAction
                          label="Revoke"
                          destructive
                          ariaLabel={`Revoke the MCP connection ${connection.name}`}
                          consequence={`The token behind "${connection.name}" stops working immediately, for every vault it could reach. ${connection.userEmail} keeps their account and can issue a new one.`}
                          pending={revokeConnection.isPending}
                          error={revokeConnection.error?.message ?? null}
                          onConfirm={() => revokeConnection.mutate(connection.id)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
