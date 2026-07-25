import { useQuery } from '@tanstack/react-query'
import { getNote } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { NoteDetail } from '../api/notes.js'

export function useNote(vaultId: string, path: string) {
  return useQuery<NoteDetail, ApiError>({
    queryKey: ['note', vaultId, path],
    queryFn: () => getNote(vaultId, path),
    enabled: Boolean(vaultId && path),
  })
}
