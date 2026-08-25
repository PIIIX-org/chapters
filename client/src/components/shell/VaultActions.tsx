import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input.js'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { useDeleteVault, useRenameVault, useRestoreVault } from '../../hooks/useVaultMutations.js'
import { useTrashedVaults } from '../../hooks/useVaults.js'
import { usePurgeVault } from '../../hooks/useTrash.js'
import type { Vault } from '../../api/vaults.js'

// ponytail: "3 days ago" granularity is enough for a trash list; no library.
function relativeIsh(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

interface VaultRowActionsProps {
  vault: Vault
}

export function VaultRowActions({ vault }: VaultRowActionsProps) {
  const [mode, setMode] = useState<'idle' | 'renaming' | 'confirmDelete'>('idle')
  const [name, setName] = useState(vault.name)
  const [error, setError] = useState<string | null>(null)
  const renameVault = useRenameVault()
  const deleteVault = useDeleteVault()

  if (vault.access !== 'owner') return null

  function submitRename(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 200) {
      setError('A vault name must be between 1 and 200 characters.')
      return
    }
    setError(null)
    renameVault.mutate(
      { id: vault.id, name: trimmed },
      {
        onSuccess: () => setMode('idle'),
        onError: (err) => setError(err.message || 'Could not rename the vault.'),
      },
    )
  }

  function confirmDelete() {
    setError(null)
    deleteVault.mutate(vault.id, {
      onSuccess: () => setMode('idle'),
      onError: (err) => setError(err.message || 'Could not move the vault to trash.'),
    })
  }

  if (mode === 'renaming') {
    return (
      <form onSubmit={submitRename} className="flex flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="New vault name"
          className="h-6"
        />
        <Button type="submit" size="xs" disabled={renameVault.isPending}>
          Save
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => {
            setMode('idle')
            setName(vault.name)
            setError(null)
          }}
        >
          Cancel
        </Button>
        <FormError message={error} />
      </form>
    )
  }

  if (mode === 'confirmDelete') {
    return (
      <div className="flex flex-1 flex-col gap-1" onClick={(e) => e.stopPropagation()}>
        <p className="text-xs text-muted-foreground">
          Move &ldquo;{vault.name}&rdquo; to trash? Its notes go with it and anyone it is shared with loses access
          immediately. You can restore it from Trash below until you purge it.
        </p>
        <div className="flex items-center gap-1">
          <Button type="button" size="xs" variant="destructive" onClick={confirmDelete} disabled={deleteVault.isPending}>
            Move to trash
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => { setMode('idle'); setError(null) }}>
            Cancel
          </Button>
        </div>
        <FormError message={error} />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setMode('renaming')}
        aria-label={`Rename ${vault.name}`}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        Rename
      </button>
      <button
        type="button"
        onClick={() => setMode('confirmDelete')}
        aria-label={`Delete ${vault.name}`}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        Delete
      </button>
    </div>
  )
}

export function VaultTrashSection() {
  const trash = useTrashedVaults()
  const restoreVault = useRestoreVault()
  const purgeVault = usePurgeVault()
  const [error, setError] = useState<string | null>(null)
  const [purging, setPurging] = useState<string | null>(null)

  // isError BEFORE .data: a 500 on the trash fetch used to make this whole
  // section vanish, four lines under a delete confirmation that promises
  // "you can restore it from Trash below" — the owner would see nothing at
  // all and conclude their vault was gone for good.
  if (trash.isError) {
    return (
      <div className="border-t border-border px-3 py-2">
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Trash</div>
        <p role="alert" className="text-xs text-destructive">
          Couldn&rsquo;t load the trash. Anything you deleted is still there — try again.
        </p>
      </div>
    )
  }
  if (!trash.data || trash.data.length === 0) return null

  return (
    <div className="border-t border-border px-3 py-2">
      <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Trash</div>
      {trash.data.map((v) => (
        <div key={v.id} className="flex items-center justify-between gap-2 py-1">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{v.name}</div>
            <div className="font-mono text-xs text-muted-foreground">{relativeIsh(v.deletedAt)}</div>
          </div>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={`Restore ${v.name}`}
            disabled={restoreVault.isPending}
            onClick={() => {
              setError(null)
              restoreVault.mutate(v.id, {
                onError: (err) => setError(err.message || 'Could not restore the vault.'),
              })
            }}
          >
            Restore
          </Button>
          {/* The delete confirmation above already promises "until you purge
              it". Until this existed, that sentence pointed at nothing. */}
          {purging !== v.id && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={`Delete ${v.name} permanently`}
              onClick={() => {
                setError(null)
                setPurging(v.id)
              }}
            >
              Delete forever
            </Button>
          )}
        </div>
      ))}
      {purging &&
        (() => {
          const target = trash.data.find((v) => v.id === purging)
          if (!target) return null
          return (
            <div className="mt-1 flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-2">
              <p className="text-xs text-muted-foreground">
                Delete &ldquo;{target.name}&rdquo; and everything in it for good? Its notes go too, including the
                ones already in the note trash, and nothing here can bring them back. Anyone it was shared with
                lost access when it was trashed and stays without it.
              </p>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="destructive"
                  disabled={purgeVault.isPending}
                  onClick={() =>
                    purgeVault.mutate(target.id, {
                      onSuccess: () => setPurging(null),
                      onError: (err) => setError(err.message || 'Could not delete the vault.'),
                    })
                  }
                >
                  Delete forever
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => setPurging(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )
        })()}
      <FormError message={error} />
    </div>
  )
}
