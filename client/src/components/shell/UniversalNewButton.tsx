import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { FileText, GitBranch, Library, Plus } from 'lucide-react'
import { Button } from '../ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { Label } from '../ui/label.js'
import { NewNoteForm } from '../vault/NewNoteForm.js'
import { NewVaultForm } from '../vault/NewVaultForm.js'
import { ConnectRepositoryDialog } from '../repositories/ConnectRepositoryDialog.js'
import { useVaults } from '../../hooks/useVaults.js'

export function UniversalNewButton() {
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams<{ vaultId?: string }>()
  const vaults = useVaults()

  const [menuOpen, setMenuOpen] = useState(false)
  const [noteModalOpen, setNoteModalOpen] = useState(false)
  const [vaultModalOpen, setVaultModalOpen] = useState(false)
  const [repoModalOpen, setRepoModalOpen] = useState(false)
  const [selectedVaultId, setSelectedVaultId] = useState<string>('')
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click or escape
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (menuRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  // Determine current vault context if inside a vault route
  const match = location.pathname.match(/^\/vaults\/([0-9a-fA-F-]+)/)
  const routeVaultId = params.vaultId || (match ? match[1] : undefined)
  const currentVaultId = routeVaultId || selectedVaultId || vaults.data?.[0]?.id

  return (
    <>
      <div ref={menuRef} className="relative pointer-events-auto">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label="Universal new item"
          className="h-8 px-2.5 rounded-full shadow-floating gap-1.5 text-xs font-medium border border-border hover:border-input bg-card hover:bg-muted text-foreground cursor-pointer flex items-center transition-all duration-150 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40 outline-none"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          <span>New</span>
        </button>

        {menuOpen && (
          <div
            role="menu"
            aria-label="New creation options"
            className="absolute right-0 top-full mt-1.5 z-50 min-w-[12rem] overflow-hidden rounded-[var(--radius-md)] border border-border bg-popover p-1 text-popover-foreground shadow-floating animate-in fade-in-0 zoom-in-95 duration-100"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                setNoteModalOpen(true)
              }}
              className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-muted hover:text-foreground text-left transition-colors"
            >
              <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
              <span>New note</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                setVaultModalOpen(true)
              }}
              className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-muted hover:text-foreground text-left transition-colors"
            >
              <Library className="size-4 text-muted-foreground" aria-hidden="true" />
              <span>New vault</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                setRepoModalOpen(true)
              }}
              className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-muted hover:text-foreground text-left transition-colors"
            >
              <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
              <span>Connect repo</span>
            </button>
          </div>
        )}
      </div>

      {/* New Vault Dialog */}
      <Dialog open={vaultModalOpen} onOpenChange={setVaultModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New vault</DialogTitle>
            <DialogDescription>
              Create a private or collaborative knowledge vault.
            </DialogDescription>
          </DialogHeader>
          <NewVaultForm
            onCreated={(vault) => {
              setVaultModalOpen(false)
              navigate(`/vaults/${vault.id}`)
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Connect Repository Dialog */}
      <ConnectRepositoryDialog
        open={repoModalOpen}
        onOpenChange={setRepoModalOpen}
        onConnected={(repo) => {
          setRepoModalOpen(false)
          navigate(`/repos/${repo.id}/files`)
        }}
      />

      {/* New Note Dialog */}
      <Dialog open={noteModalOpen} onOpenChange={setNoteModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New note</DialogTitle>
            <DialogDescription>
              Create a new note formatted in Open Knowledge Format (OKF).
            </DialogDescription>
          </DialogHeader>

          {vaults.isLoading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">Loading vaults…</div>
          ) : currentVaultId ? (
            <div className="flex flex-col gap-3">
              {!routeVaultId && vaults.data && vaults.data.length > 1 && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="unb-target-vault">Target vault</Label>
                  <select
                    id="unb-target-vault"
                    value={currentVaultId}
                    onChange={(e) => setSelectedVaultId(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {vaults.data.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <NewNoteForm
                vaultId={currentVaultId}
                existingTypes={[]}
                onCreated={(note) => {
                  setNoteModalOpen(false)
                  navigate(`/vaults/${currentVaultId}/notes/${note.path}`)
                }}
              />
            </div>
          ) : (
            <div className="py-4 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
              <p>No vaults found. Create a vault first to start creating notes.</p>
              <Button
                size="sm"
                onClick={() => {
                  setNoteModalOpen(false)
                  setVaultModalOpen(true)
                }}
              >
                Create a vault
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
