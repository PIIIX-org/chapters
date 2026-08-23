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
import { FormError } from '../FormError.js'
import { useUpdateVault } from '../../hooks/useVaultMutations.js'
import { SharingPanel } from './SharingPanel.js'
import { VaultMcpPanel } from './VaultMcpPanel.js'
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
  const updateVault = useUpdateVault()

  function handleMergeableChange(next: boolean) {
    setMergeable(next)
    setError(null)
    updateVault.mutate(
      { id: vault.id, patch: { mergeable: next } },
      {
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

        <SharingPanel vaultId={vault.id} />

        <VaultMcpPanel vaultId={vault.id} />
      </DialogContent>
    </Dialog>
  )
}
