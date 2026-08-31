import { useState } from 'react'
import { Outlet, useNavigate, useParams } from 'react-router'
import { Plus, Trash2 } from 'lucide-react'
import { useVaults } from '../../hooks/useVaults.js'
import { useVaultTree } from '../../hooks/useVaultTree.js'
import { FileTree } from '../../components/vault/FileTree.js'
import { NoteTrashPanel } from '../../components/vault/NoteTrashPanel.js'
import { canEdit } from '../../api/vaults.js'
import { NewNoteForm } from '../../components/vault/NewNoteForm.js'
import { ContextPanel } from '../../components/shell/ShellPanels.js'
import { useShellBreadcrumb } from '../../components/shell/shell-context.js'
import { Button } from '../../components/ui/button.js'
import { Eyebrow } from '../../components/ui/eyebrow.js'

export function VaultLayout() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const vaults = useVaults()
  const tree = useVaultTree(vaultId!)
  const vault = vaults.data?.find((v) => v.id === vaultId)
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const existingTypes = Object.keys(tree.data ?? {})
  const editable = canEdit(vault?.access)
  useShellBreadcrumb([
    { label: 'Vaults', to: '/vaults' },
    { label: vault?.name ?? 'Vault' },
  ])

  return (
    <>
      <ContextPanel label={vault?.name ?? 'Vault'}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <Eyebrow as="h2" className="min-w-0 flex-1 truncate">
            {vault?.name ?? 'Vault'}
          </Eyebrow>
          {editable && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="New note"
              aria-expanded={creating}
              onClick={() => setCreating((c) => !c)}
            >
              <Plus aria-hidden="true" />
            </Button>
          )}
        </div>
        {editable && creating && (
          <div className="border-b border-border p-3">
            <NewNoteForm
              vaultId={vaultId!}
              existingTypes={existingTypes}
              onCreated={(note) => {
                setCreating(false)
                navigate(`/vaults/${vaultId}/notes/${note.path}`)
              }}
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {tree.data && (
            <FileTree vaultId={vaultId!} tree={tree.data} canEdit={editable} />
          )}
        </div>
        {/* Pinned under the tree: the way back for deleted notes. Restore
            needs edit access server-side, so readers do not get a row that
            can only ever 403. */}
        {editable && (
          <div className="shrink-0 border-t border-border">
            <button
              type="button"
              aria-expanded={trashOpen}
              onClick={() => setTrashOpen((o) => !o)}
              className="flex h-9 w-full items-center gap-2 px-3 font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              Trash
            </button>
            {trashOpen && (
              <div className="max-h-72 overflow-y-auto border-t border-border p-3">
                <NoteTrashPanel vaultId={vaultId!} heading={false} />
              </div>
            )}
          </div>
        )}
      </ContextPanel>
      <div className="h-full min-h-0">
        <Outlet context={vault} />
      </div>
    </>
  )
}
