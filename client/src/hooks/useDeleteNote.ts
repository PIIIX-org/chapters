import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteNote } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { DeleteNoteResult } from '../api/notes.js'

export function useDeleteNote(vaultId: string) {
  const queryClient = useQueryClient()
  return useMutation<DeleteNoteResult, ApiError, string>({
    mutationFn: (path) => deleteNote(vaultId, path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vault-tree', vaultId] })
    },
  })
}
