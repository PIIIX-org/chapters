import { useState } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { Label } from '../ui/label.js'
import { Input } from '../ui/input.js'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { useDeleteVault, useUpdateVault } from '../../hooks/useVaultMutations.js'
import { useSetVaultGraphPreference, useVaultGraphPreference } from '../../hooks/useVaults.js'
import { SharingPanel } from './SharingPanel.js'
import { VaultMcpPanel } from './VaultMcpPanel.js'
import { VaultExportPanel } from './VaultExportPanel.js'
import { NoteTrashPanel } from './NoteTrashPanel.js'
import type { Vault } from '../../api/vaults.js'

interface VaultSettingsModalProps {
  vault: Vault
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function VaultSettingsModal({ vault, open, onOpenChange }: VaultSettingsModalProps) {
  // ponytail: no effect to resync from `vault.mergeable` — ScopePicker fully
  // unmounts this modal on close (`{settingsOpen && ...}`), so a fresh mount
  // always starts from the current server value; add a resync effect only if
  // this modal ever stays mounted across a vault switch.
  const [mergeable, setMergeable] = useState(vault.mergeable)
  const [error, setError] = useState<string | null>(null)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [deleteName, setDeleteName] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const updateVault = useUpdateVault()
  const deleteVault = useDeleteVault()
  const graphPreference = useVaultGraphPreference(vault.id)
  const setGraphPreference = useSetVaultGraphPreference(vault.id)

  function handleDeleteVault() {
    setDeleteError(null)
    deleteVault.mutate(vault.id, {
      onSuccess: () => {
        onOpenChange(false)
      },
      onError: (err) => {
        setDeleteError(err.message || 'Could not delete the vault.')
      },
    })
  }

  const graphInclude =
    !graphPreference.isError && graphPreference.data
      ? graphPreference.data.include
      : vault.access === 'owner' && mergeable

  function handleMergeableChange(next: boolean) {
    setMergeable(next)
    setError(null)
    updateVault.mutate(
      { id: vault.id, patch: { mergeable: next } },
      {
        onSuccess: () => {
          if (next && !graphInclude) {
            setGraphPreference.mutate(true)
          }
        },
        onError: (err) => {
          // Roll back: this must never sit "on" after a failed write.
          setMergeable(!next)
          setError(err.message || 'Could not update merging for this vault.')
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vault settings — {vault.name}</DialogTitle>
        </DialogHeader>

        <section className="flex flex-col gap-2">
          <h3 className="font-display text-base text-foreground">Merging</h3>
          <div className="flex items-center gap-2">
            <SwitchPrimitive.Root
              id="vault-mergeable"
              checked={mergeable}
              onCheckedChange={handleMergeableChange}
              disabled={updateVault.isPending}
              className="relative h-5 w-9 shrink-0 rounded-full border border-border bg-muted transition-colors data-[state=checked]:bg-foreground disabled:opacity-50"
            >
              <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-card transition-transform data-[state=checked]:translate-x-[18px]" />
            </SwitchPrimitive.Root>
            <Label htmlFor="vault-mergeable">Mergeable</Label>
          </div>
          <DialogDescription>
            {mergeable
              ? 'Anyone this vault is shared with can fold its notes into their own merged graph view.'
              : "This vault stays out of everyone's merged graph view, including your own."}
          </DialogDescription>
          <FormError message={error} />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="font-display text-base text-foreground">My merged graph</h3>
          <div className="flex items-center gap-2">
            <SwitchPrimitive.Root
              id="vault-graph-preference"
              checked={graphInclude}
              disabled={graphPreference.isPending || graphPreference.isError || setGraphPreference.isPending}
              onCheckedChange={(next) => {
                setGraphError(null)
                setGraphPreference.mutate(next, {
                  onError: (err) =>
                    setGraphError(err.message || 'Could not update your graph preference.'),
                })
              }}
              className="relative h-5 w-9 shrink-0 rounded-full border border-border bg-muted transition-colors data-[state=checked]:bg-foreground disabled:opacity-50"
            >
              <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-card transition-transform data-[state=checked]:translate-x-[18px]" />
            </SwitchPrimitive.Root>
            <Label htmlFor="vault-graph-preference">Include in my merged graph</Label>
          </div>
          <DialogDescription>
            {graphPreference.isError
              ? 'Could not load your graph preference, so this switch is showing nothing rather than guessing.'
              : mergeable
                ? 'Yours alone — this is where your own merged graph is decided, not what anyone else sees.'
                : 'Merging is off for this vault, so this has no effect until you turn it on above.'}
          </DialogDescription>
          <FormError message={graphError} />
        </section>

        <SharingPanel vaultId={vault.id} />

        <VaultMcpPanel vaultId={vault.id} />

        <NoteTrashPanel vaultId={vault.id} />

        <VaultExportPanel vaultId={vault.id} />

        {vault.access === 'owner' && (
          <section className="flex flex-col gap-2 rounded-md border border-destructive/20 bg-destructive/5 p-3">
            <h3 className="font-display text-base text-destructive">Danger zone</h3>
            <p className="text-xs text-muted-foreground">
              To delete &ldquo;{vault.name}&rdquo;, type its name below to confirm. Its notes go with it and anyone it is shared with loses access immediately.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={deleteName}
                onChange={(e) => {
                  setDeleteName(e.target.value)
                  setDeleteError(null)
                }}
                placeholder={vault.name}
                aria-label={`Type ${vault.name} to confirm deletion`}
                className="flex-1"
              />
              <Button
                type="button"
                variant="destructive"
                disabled={deleteName !== vault.name || deleteVault.isPending}
                onClick={handleDeleteVault}
              >
                Delete vault
              </Button>
            </div>
            <FormError message={deleteError} />
          </section>
        )}
      </DialogContent>
    </Dialog>
  )
}
