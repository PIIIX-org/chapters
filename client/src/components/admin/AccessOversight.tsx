import { ConfirmAction } from './ConfirmAction.js'
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
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title="Shares" />
        <p className="border-b border-border px-3 py-2 text-[13px] text-muted-foreground">
          Every grant on the instance. Revoking one cuts that person or team
          off the vault immediately — access is re-checked on every request,
          so there is no session to wait out.
        </p>
        {shares.isPending ? (
          <PanelState status="loading" compact message="Loading shares…" />
        ) : shares.isError ? (
          <PanelState status="error" compact message={shares.error.message} />
        ) : shares.data.length === 0 ? (
          <PanelState
            status="empty"
            compact
            message="Nothing is shared on this instance yet."
          />
        ) : (
          <Table>
            <caption className="sr-only">Every vault share on this instance</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Vault</TableHead>
                <TableHead scope="col">Shared with</TableHead>
                <TableHead scope="col">Permission</TableHead>
                <TableHead scope="col">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shares.data.map((share) => {
                const vault = vaultName.get(share.vaultId) ?? 'deleted vault'
                const grantee = granteeLabel(share.granteeType, share.granteeId)
                return (
                  <TableRow key={share.id}>
                    <TableCell className="py-2.5 align-top text-foreground">
                      {vault}
                    </TableCell>
                    <TableCell className="py-2 align-top">
                      <span className="mr-1.5 text-foreground">{grantee}</span>
                      <Pill tone="neutral">{share.granteeType}</Pill>
                    </TableCell>
                    <TableCell className="py-2.5 align-top font-mono text-xs text-muted-foreground">
                      {share.permission}
                    </TableCell>
                    <TableCell className="py-2 align-top">
                      <ConfirmAction
                        label="Revoke"
                        destructive
                        ariaLabel={`Revoke ${grantee}'s access to ${vault}`}
                        consequence={`${grantee} loses access to "${vault}" on their very next request. Any note they have open stops saving. The owner can share it again afterwards.`}
                        pending={revokeShare.isPending}
                        error={revokeShare.error?.message ?? null}
                        onConfirm={() => revokeShare.mutate(share.id)}
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="MCP connections" />
        <p className="border-b border-border px-3 py-2 text-[13px] text-muted-foreground">
          Tokens AI clients use to reach this instance. Revoking one kills
          that token only — the account keeps working, which is the point of
          having this next to Deactivate rather than instead of it.
        </p>
        {connections.isPending ? (
          <PanelState status="loading" compact message="Loading connections…" />
        ) : connections.isError ? (
          <PanelState status="error" compact message={connections.error.message} />
        ) : connections.data.length === 0 ? (
          <PanelState
            status="empty"
            compact
            message="No MCP connections on this instance yet."
          />
        ) : (
          <Table>
            <caption className="sr-only">Every MCP connection on this instance</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Connection</TableHead>
                <TableHead scope="col">Account</TableHead>
                <TableHead scope="col">Scope</TableHead>
                <TableHead scope="col">Last used</TableHead>
                <TableHead scope="col">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connections.data.map((connection) => (
                <TableRow key={connection.id}>
                  <TableCell className="py-2.5 align-top text-foreground">
                    {connection.name}
                  </TableCell>
                  <TableCell className="py-2.5 align-top text-muted-foreground">
                    {connection.userEmail}
                  </TableCell>
                  <TableCell className="py-2.5 align-top font-mono text-xs text-muted-foreground">
                    {connection.scope}
                    {connection.vaultId && (
                      <span className="block">
                        {vaultName.get(connection.vaultId) ?? 'deleted vault'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-2.5 align-top font-mono text-xs text-muted-foreground">
                    {formatStamp(connection.lastUsedAt)}
                  </TableCell>
                  <TableCell className="py-2 align-top">
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  )
}
