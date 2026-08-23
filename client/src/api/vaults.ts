import { apiFetch } from '../lib/api.js'

export type VaultAccess = 'read' | 'edit' | 'owner'

export interface Vault {
  id: string
  name: string
  ownerId: string
  mergeable: boolean
  access: VaultAccess
}

export interface TrashedVault {
  id: string
  name: string
  deletedAt: string
}

export function listVaults(): Promise<Vault[]> {
  return apiFetch('/vaults')
}

export function createVault(name: string): Promise<Vault> {
  return apiFetch('/vaults', { method: 'POST', body: JSON.stringify({ name }) })
}

export function renameVault(id: string, name: string): Promise<Vault> {
  return apiFetch(`/vaults/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
}

export function deleteVault(id: string): Promise<{ status: 'trashed'; id: string }> {
  return apiFetch(`/vaults/${id}`, { method: 'DELETE' })
}

export function listTrashedVaults(): Promise<TrashedVault[]> {
  return apiFetch('/vaults/trash')
}

export function restoreVault(id: string): Promise<Vault> {
  return apiFetch(`/vaults/${id}/restore`, { method: 'POST' })
}

/** Editing is allowed only for edit/owner access; unknown access is not. */
export function canEdit(access: VaultAccess | undefined): boolean {
  return access === 'edit' || access === 'owner'
}
