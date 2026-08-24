import { lazy, Suspense, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useVaults } from '../../hooks/useVaults.js'
import { NewVaultForm } from '../vault/NewVaultForm.js'
import { VaultRowActions, VaultTrashSection } from './VaultActions.js'
import type { Vault } from '../../api/vaults.js'

// Lazy: keeps the radix dialog (and everything the settings modal pulls in)
// out of the entry chunk — see client/src/bundle.test.ts.
const VaultSettingsModal = lazy(() =>
  import('../vault/VaultSettingsModal.js').then((m) => ({ default: m.VaultSettingsModal })),
)

export function ScopePicker() {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const vaults = useVaults()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()

  const vaultId = searchParams.get('vault')
  const activeVault = vaultId ? vaults.data?.find((v) => v.id === vaultId) : undefined
  const label = vaultId && activeVault ? activeVault.name : 'All vaults'

  function select(id: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('vault', id)
      else next.delete('vault')
      return next
    })
    close()
  }

  function close() {
    setOpen(false)
    setCreating(false)
  }

  function toggle() {
    setOpen((o) => !o)
    setCreating(false)
  }

  function handleCreated(vault: Vault) {
    close()
    navigate(`/vaults/${vault.id}`)
  }

  // Bound to the wrapper, not the <ul>: after clicking the trigger, focus
  // sits on the trigger button, a sibling of the popup — not a descendant of
  // the listbox — so a real Escape keydown bubbles trigger -> this div and
  // never reaches a handler on the <ul>.
  //
  // The vault settings modal is a Radix Dialog: it portals its DOM into
  // document.body, but React synthetic events still propagate along the
  // React tree, not the DOM tree — so the dialog's own Escape handler and
  // this one both see the same keydown. Guard while the modal is open, or
  // one Escape closes both layers and yanks focus toward a trigger button
  // Radix's FocusScope is also about to restore focus to mid-unmount.
  function onKeyDown(e: KeyboardEvent) {
    if (settingsOpen) return
    if (e.key === 'Escape') {
      close()
      triggerRef.current?.focus()
    }
  }

  return (
    <div className="relative inline-block" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="scope-list"
        disabled={vaults.isPending}
        onClick={toggle}
        className="rounded-md px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-100"
      >
        {label}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 min-w-[12rem] rounded-md border border-border bg-popover py-1 shadow-md">
          <ul id="scope-list" role="listbox" aria-label="Scope">
            <li role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={!vaultId}
                onClick={() => select(null)}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
              >
                All vaults
              </button>
            </li>
            {vaults.data?.map((v) => (
              <li key={v.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={v.id === vaultId}
                  onClick={() => select(v.id)}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                >
                  {v.name}
                </button>
              </li>
            ))}
          </ul>
          {/* Actions live outside the listbox's DOM subtree on purpose:
              role="listbox" requires every descendant of its options/groups to
              itself be an option, so rename/delete controls cannot be nested
              inside it without an aria-required-children violation. Keyed to
              the currently selected vault rather than listing every owned
              vault again here, which used to repeat each name a second time
              in the same open panel. */}
          {activeVault?.access === 'owner' && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{activeVault.name}</span>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Vault settings
              </button>
              <VaultRowActions vault={activeVault} />
            </div>
          )}
          <VaultTrashSection />
          <div className="border-t border-border p-2">
            {creating ? (
              <NewVaultForm onCreated={handleCreated} />
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="block w-full rounded-md px-1 py-1 text-left text-sm hover:bg-muted"
              >
                + New vault
              </button>
            )}
          </div>
        </div>
      )}
      {settingsOpen && activeVault?.access === 'owner' && (
        <Suspense fallback={null}>
          <VaultSettingsModal vault={activeVault} open={settingsOpen} onOpenChange={setSettingsOpen} />
        </Suspense>
      )}
    </div>
  )
}
