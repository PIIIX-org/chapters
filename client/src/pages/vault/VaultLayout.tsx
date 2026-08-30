import { useState } from 'react'
import { Outlet, useNavigate, useParams } from 'react-router'
import { Plus } from 'lucide-react'
import { useVaults } from '../../hooks/useVaults.js'
import { useVaultTree } from '../../hooks/useVaultTree.js'
import { FileTree } from '../../components/vault/FileTree.js'
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
      </ContextPanel>
      <div className="h-full min-h-0">
        <Outlet context={vault} />
      </div>
    </>
  )
}
