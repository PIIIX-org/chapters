import { apiFetch } from '../lib/api.js'

export type VaultAccess = 'read' | 'edit' | 'owner'

export interface Vault {
  id: string
  name: string
  ownerId: string
  mergeable: boolean
  access: VaultAccess
}

export function listVaults(): Promise<Vault[]> {
  return apiFetch('/vaults')
}

export function getVaultAccess(vaultId: string): Promise<{ access: VaultAccess }> {
  return apiFetch(`/vaults/${vaultId}/access`)
}
