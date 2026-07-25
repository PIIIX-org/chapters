import { useState } from 'react'
import { Link, Outlet, useNavigate, useParams } from 'react-router'
import { useVaults } from '../../hooks/useVaults.js'
import { useVaultTree } from '../../hooks/useVaultTree.js'
import { FileTree } from '../../components/vault/FileTree.js'
import { canEdit } from '../../api/vaults.js'
import { NewNoteForm } from '../../components/vault/NewNoteForm.js'

export function VaultLayout() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const vaults = useVaults()
  const tree = useVaultTree(vaultId!)
  const vault = vaults.data?.find((v) => v.id === vaultId)
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const existingTypes = Object.keys(tree.data ?? {})

  return (
    <div className="flex min-h-screen">
      <aside className="w-[220px] shrink-0 border-r border-border bg-secondary p-4">
        <Link to="/" className="mb-4 block text-sm text-muted-foreground underline">
          ← Vaults
        </Link>
        {canEdit(vault?.access) && (
          <div className="mb-4">
            {creating ? (
              <NewNoteForm
                vaultId={vaultId!}
                existingTypes={existingTypes}
                onCreated={(note) => {
                  setCreating(false)
                  navigate(`/vaults/${vaultId}/notes/${note.path}`)
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="w-full rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted"
              >
                + New note
              </button>
            )}
          </div>
        )}
        {tree.data && <FileTree vaultId={vaultId!} tree={tree.data} />}
      </aside>
      <div className="flex-1">
        <Outlet context={vault} />
      </div>
    </div>
  )
}
