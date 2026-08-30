import { useNavigate } from 'react-router'
import { NewVaultForm } from './NewVaultForm.js'
import type { Vault } from '../../api/vaults.js'

export function VaultEmptyState() {
  const navigate = useNavigate()

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <h1 className="font-display text-2xl">Your graph is empty</h1>
      <p className="max-w-sm text-muted-foreground">
        A vault holds your notes, and the graph draws the links between them — create one to get started.
      </p>
      <div className="w-full max-w-xs text-left">
        <NewVaultForm onCreated={(vault: Vault) => navigate(`/vaults/${vault.id}`)} />
      </div>
    </div>
  )
}
