import { useState } from 'react'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { useAdminTeams, useAdminUsers, useAdminVaults, useTransferVaultOwner } from '../../hooks/useAdmin.js'
import type { AdminVault } from '../../api/admin.js'

const activity = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

function formatActivity(iso: string | null): string {
  if (!iso) return 'No activity yet'
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? 'No activity yet' : activity.format(parsed)
}

const selectClassName =
  'h-7 rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function TransferOwner({ vault }: { vault: AdminVault }) {
  const users = useAdminUsers()
  const transfer = useTransferVaultOwner()
  const [open, setOpen] = useState(false)
  const [newOwnerId, setNewOwnerId] = useState('')

  // The server rejects anyone who isn't active; offering them would just be a
  // 400 with extra steps.
  const candidates = (users.data ?? []).filter((u) => u.status === 'active' && u.email !== vault.ownerEmail)

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
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">No other active account to hand this vault to.</p>
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    )
  }

  const selected = newOwnerId || candidates[0]!.id
  const selectedEmail = candidates.find((c) => c.id === selected)?.email ?? ''

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-2">
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
        {selectedEmail} becomes the owner of &ldquo;{vault.name}&rdquo;. {vault.ownerEmail} keeps no special
        access — reshare it with them if they still need it.
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
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h3 className="font-display text-lg text-foreground">Vaults</h3>
        {vaults.isPending ? (
          <p className="text-sm text-muted-foreground">Loading vaults…</p>
        ) : vaults.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {vaults.error.message}
          </p>
        ) : vaults.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No vaults on this instance yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Every vault on this instance — names and counts only</caption>
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Vault
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Owner
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Notes
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Shares
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Mergeable
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Last activity
                  </th>
                  <th scope="col" className="py-2 font-normal">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {vaults.data.map((vault) => (
                  <tr key={vault.id} className="border-b border-border align-top">
                    <td className="py-2 pr-4 text-foreground">{vault.name}</td>
                    <td className="py-2 pr-4 text-foreground">{vault.ownerEmail}</td>
                    <td className="py-2 pr-4 text-foreground">{vault.noteCount}</td>
                    <td className="py-2 pr-4 text-foreground">{vault.shareCount}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {vault.mergeable ? 'yes' : 'no'}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {formatActivity(vault.lastActivity)}
                    </td>
                    <td className="py-2">
                      <TransferOwner vault={vault} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-display text-lg text-foreground">Teams</h3>
        {teams.isPending ? (
          <p className="text-sm text-muted-foreground">Loading teams…</p>
        ) : teams.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {teams.error.message}
          </p>
        ) : teams.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No teams on this instance yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Every team on this instance</caption>
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Team
                  </th>
                  <th scope="col" className="py-2 font-normal">
                    Members
                  </th>
                </tr>
              </thead>
              <tbody>
                {teams.data.map((team) => (
                  <tr key={team.id} className="border-b border-border">
                    <td className="py-2 pr-4 text-foreground">{team.name}</td>
                    <td className="py-2 text-foreground">{team.memberCount}</td>
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
