import { apiFetch } from '../lib/api.js'

export interface NoteSummary {
  id: string
  path: string
  type: string
  name: string
  frontmatter: Record<string, unknown>
  updatedAt: string
}

export type VaultTree = Record<string, NoteSummary[]>

export function getVaultTree(vaultId: string): Promise<VaultTree> {
  return apiFetch(`/vaults/${vaultId}/tree`)
}

export interface NoteDetail {
  path: string
  frontmatter: Record<string, unknown>
  body: string
  updatedAt: string
}

export function getNote(vaultId: string, path: string): Promise<NoteDetail> {
  return apiFetch(`/vaults/${vaultId}/notes/${path}`)
}

export interface UpdateNoteInput {
  frontmatter?: Record<string, unknown>
  body?: string
}

export interface UpdateNoteResult {
  id: string
  path: string
  frontmatter: Record<string, unknown>
  body: string
  updatedAt: string
}

export function updateNote(vaultId: string, path: string, input: UpdateNoteInput): Promise<UpdateNoteResult> {
  return apiFetch(`/vaults/${vaultId}/notes/${path}`, { method: 'PUT', body: JSON.stringify(input) })
}
