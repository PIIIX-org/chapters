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

export interface CreateNoteInput {
  type: string
  name: string
}

export interface CreateNoteResult {
  id: string
  path: string
  type: string
  name: string
}

export function createNote(vaultId: string, input: CreateNoteInput): Promise<CreateNoteResult> {
  return apiFetch(`/vaults/${vaultId}/notes`, { method: 'POST', body: JSON.stringify(input) })
}

export interface RenameNoteInput {
  from: string
  to: string
}

export interface RenameNoteResult {
  id: string
  path: string
  type: string
  name: string
}

export function renameNote(vaultId: string, input: RenameNoteInput): Promise<RenameNoteResult> {
  return apiFetch(`/vaults/${vaultId}/notes-rename`, { method: 'POST', body: JSON.stringify(input) })
}

export interface DeleteNoteResult {
  status: string
  id: string
}

export function deleteNote(vaultId: string, path: string): Promise<DeleteNoteResult> {
  return apiFetch(`/vaults/${vaultId}/notes/${path}`, { method: 'DELETE' })
}

/** A soft-deleted note. Restorable until the vault itself is purged. */
export interface TrashedNote {
  id: string
  path: string
  type: string
  name: string
  deletedAt: string
}

/** Requires edit access — the server guards it, this is not a client rule. */
export function listTrashedNotes(vaultId: string): Promise<TrashedNote[]> {
  return apiFetch(`/vaults/${vaultId}/trash`)
}

export function restoreNote(vaultId: string, noteId: string): Promise<{ id: string; path: string }> {
  return apiFetch(`/vaults/${vaultId}/trash/${noteId}/restore`, { method: 'POST' })
}
