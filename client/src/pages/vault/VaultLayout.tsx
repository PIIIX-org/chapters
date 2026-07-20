import { Link, Outlet, useParams } from 'react-router'
import { useVaults } from '../../hooks/useVaults.js'
import { useVaultTree } from '../../hooks/useVaultTree.js'
import { FileTree } from '../../components/vault/FileTree.js'

export function VaultLayout() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const vaults = useVaults()
  const tree = useVaultTree(vaultId!)
  const vault = vaults.data?.find((v) => v.id === vaultId)

  return (
    <div className="flex min-h-screen">
      <aside className="w-[220px] shrink-0 border-r border-border bg-secondary p-4">
        <Link to="/" className="mb-4 block text-sm text-muted-foreground underline">
          ← Vaults
        </Link>
        {tree.data && <FileTree vaultId={vaultId!} tree={tree.data} />}
      </aside>
      <div className="flex-1">
        <Outlet context={vault} />
      </div>
    </div>
  )
}
