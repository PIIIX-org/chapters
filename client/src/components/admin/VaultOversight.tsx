import { useState } from 'react'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { PanelState } from '../ui/empty-state.js'
import { Panel, PanelHeader } from '../ui/panel.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js'
import {
  useAdminTeams,
  useAdminUsers,
  useAdminVaults,
  useTransferVaultOwner,
} from '../../hooks/useAdmin.js'
import type { AdminVault } from '../../api/admin.js'

const activity = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

function formatActivity(iso: string | null): string {
  if (!iso) return 'No activity yet'
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? 'No activity yet' : activity.format(parsed)
}

const selectClassName =
  'h-7 rounded-md border border-input bg-card px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40'

function TransferOwner({ vault }: { vault: AdminVault }) {
  const users = useAdminUsers()
  const transfer = useTransferVaultOwner()
  const [open, setOpen] = useState(false)
  const [newOwnerId, setNewOwnerId] = useState('')

  // The server rejects anyone who is not active; offering them would just be
  // a 400 with extra steps.
  const candidates = (users.data ?? []).filter(
    (u) => u.status === 'active' && u.email !== vault.ownerEmail,
  )

  if (!open) {
    return (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={`Reassign ownership of ${vault.name}`}
        onClick={() => setOpen(true)}
      >
        Reassign owner
      </Button>
    )
  }

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col items-start gap-1 whitespace-normal">
        <p className="text-xs text-muted-foreground">
          No other active account to hand this vault to.
        </p>
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    )
  }

  const selected = newOwnerId || candidates[0]!.id
  const selectedEmail = candidates.find((c) => c.id === selected)?.email ?? ''

  return (
    <div className="flex max-w-md min-w-56 flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-2 text-left whitespace-normal">
      <label className="sr-only" htmlFor={`owner-${vault.id}`}>
        New owner for {vault.name}
      </label>
      <select
        id={`owner-${vault.id}`}
        className={selectClassName}
        value={selected}
        onChange={(e) => setNewOwnerId(e.target.value)}
      >
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.email}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        {selectedEmail} becomes the owner of &ldquo;{vault.name}&rdquo;.{' '}
        {vault.ownerEmail} keeps no special access — reshare it with them if
        they still need it.
      </p>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="xs"
          disabled={transfer.isPending}
          onClick={() =>
            transfer.mutate(
              { vaultId: vault.id, newOwnerId: selected },
              { onSuccess: () => setOpen(false) },
            )
          }
        >
          Reassign
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <FormError message={transfer.error?.message ?? null} />
    </div>
  )
}

/** Vaults and teams, structurally: names, counts, owners. Never a note. */
export function VaultOversight() {
  const vaults = useAdminVaults()
  const teams = useAdminTeams()

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title="Vaults" />
        {vaults.isPending ? (
          <PanelState status="loading" compact message="Loading vaults…" />
        ) : vaults.isError ? (
          <PanelState status="error" compact message={vaults.error.message} />
        ) : vaults.data.length === 0 ? (
          <PanelState status="empty" compact message="No vaults on this instance yet." />
        ) : (
          <Table>
            <caption className="sr-only">
              Every vault on this instance — names and counts only
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Vault</TableHead>
                <TableHead scope="col">Owner</TableHead>
                <TableHead scope="col">Notes</TableHead>
                <TableHead scope="col">Shares</TableHead>
                <TableHead scope="col">Mergeable</TableHead>
                <TableHead scope="col">Last activity</TableHead>
                <TableHead scope="col">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vaults.data.map((vault) => (
                <TableRow key={vault.id}>
                  <TableCell className="py-2.5 align-top text-foreground">
                    {vault.name}
                  </TableCell>
                  <TableCell className="py-2.5 align-top text-muted-foreground">
                    {vault.ownerEmail}
                  </TableCell>
                  <TableCell className="py-2.5 align-top font-mono text-xs tabular-nums text-foreground">
                    {vault.noteCount}
                  </TableCell>
                  <TableCell className="py-2.5 align-top font-mono text-xs tabular-nums text-foreground">
                    {vault.shareCount}
                  </TableCell>
                  <TableCell className="py-2.5 align-top font-mono text-xs text-muted-foreground">
                    {vault.mergeable ? 'yes' : 'no'}
                  </TableCell>
                  <TableCell className="py-2.5 align-top font-mono text-xs text-muted-foreground">
                    {formatActivity(vault.lastActivity)}
                  </TableCell>
                  <TableCell className="py-2 align-top">
                    <TransferOwner vault={vault} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Teams" />
        {teams.isPending ? (
          <PanelState status="loading" compact message="Loading teams…" />
        ) : teams.isError ? (
          <PanelState status="error" compact message={teams.error.message} />
        ) : teams.data.length === 0 ? (
          <PanelState status="empty" compact message="No teams on this instance yet." />
        ) : (
          <Table>
            <caption className="sr-only">Every team on this instance</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Team</TableHead>
                <TableHead scope="col">Members</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.data.map((team) => (
                <TableRow key={team.id}>
                  <TableCell className="text-foreground">{team.name}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-foreground">
                    {team.memberCount}
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
