import { useQuery } from '@tanstack/react-query'
import { getNote, getVaultTree } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { NoteDetail } from '../api/notes.js'

export function useNote(vaultId: string, path: string) {
  return useQuery<NoteDetail, ApiError>({
    queryKey: ['note', vaultId, path],
    queryFn: () => getNote(vaultId, path),
    enabled: Boolean(vaultId && path),
  })
}

/**
 * The current path of live note `noteId` in the vault, or null when no live
 * note has that id (trashed or purged). Disabled without an id. A page whose
 * note was renamed elsewhere looks its note up by id (the collab document
 * is named by id since ADR-003 S2b, so the editor stays connected) instead
 * of saying "Note not found" at the old path.
 */
export function useNotePathById(vaultId: string, noteId: string | undefined) {
  return useQuery<string | null, ApiError>({
    queryKey: ['note-path-by-id', vaultId, noteId],
    queryFn: async () => {
      const tree = await getVaultTree(vaultId)
      for (const notes of Object.values(tree)) {
        const found = notes.find((n) => n.id === noteId)
        if (found) return found.path
      }
      return null
    },
    enabled: Boolean(vaultId && noteId),
  })
}
