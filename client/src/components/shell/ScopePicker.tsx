import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { BookOpen, Check, ChevronDown, Plus, Settings, Waypoints } from 'lucide-react'
import { useVaults } from '../../hooks/useVaults.js'
import { NewVaultForm } from '../vault/NewVaultForm.js'
import { VaultRowActions, VaultTrashSection } from './VaultActions.js'
import { cn } from '../../lib/utils.js'
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
  const wrapperRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (wrapperRef.current?.contains(target) || target.closest('[data-radix-popper-content-wrapper]') || target.closest('[role="dialog"]')) return
      close()
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

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

  function onKeyDown(e: KeyboardEvent) {
    if (settingsOpen) return
    if (e.key === 'Escape') {
      close()
      triggerRef.current?.focus()
    }
  }

  return (
    <div ref={wrapperRef} className="relative inline-block" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="scope-list"
        disabled={vaults.isPending}
        onClick={toggle}
        className="flex h-9 items-center gap-2 rounded-[var(--radius-md,4px)] border border-border bg-card/95 backdrop-blur-xs px-3 text-sm font-medium text-foreground hover:bg-muted hover:border-input shadow-floating focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-95 transition-all cursor-pointer disabled:opacity-100"
      >
        <Waypoints className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 min-w-[16rem] max-w-sm rounded-[var(--radius-lg,8px)] border border-border bg-popover text-popover-foreground py-1 shadow-2xl overflow-hidden animate-in fade-in-0 zoom-in-95 duration-100">
          <ul id="scope-list" role="listbox" aria-label="Scope" className="max-h-64 overflow-y-auto overscroll-contain py-0.5 divide-y divide-border/20">
            <li role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={!vaultId}
                onClick={() => select(null)}
                className={cn(
                  'flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors cursor-pointer',
                  !vaultId ? 'bg-muted/90 text-foreground font-medium' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted',
                )}
              >
                <span className="flex items-center gap-2">
                  <Waypoints className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span>All vaults</span>
                </span>
                {!vaultId && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
              </button>
            </li>
            {vaults.data?.map((v) => (
              <li key={v.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={v.id === vaultId}
                  onClick={() => select(v.id)}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors cursor-pointer',
                    v.id === vaultId ? 'bg-muted/90 text-foreground font-medium' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted',
                  )}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate">{v.name}</span>
                  </span>
                  {v.id === vaultId && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
          {/* Actions live outside the listbox's DOM subtree on purpose:
              role="listbox" requires every descendant of its options/groups to
              itself be an option, so rename/delete controls cannot be nested
              inside it without an aria-required-children violation. */}
          {activeVault?.access === 'owner' && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1.5 bg-muted/20">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground font-mono">{activeVault.name}</span>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border/50 bg-card hover:bg-muted active:scale-95 transition-all cursor-pointer shadow-xs"
              >
                <Settings className="size-3" aria-hidden="true" />
                <span>Vault settings</span>
              </button>
              <VaultRowActions vault={activeVault} />
            </div>
          )}
          <VaultTrashSection />
          <div className="border-t border-border p-2 bg-muted/10">
            {creating ? (
              <NewVaultForm onCreated={handleCreated} />
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="inline-flex items-center gap-2 w-full rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-muted/80 active:scale-95 transition-all cursor-pointer border border-dashed border-border/70 hover:border-border"
              >
                <Plus className="size-3.5 text-primary" aria-hidden="true" />
                <span>+ New vault</span>
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
