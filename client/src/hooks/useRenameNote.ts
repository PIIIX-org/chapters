import { useMutation, useQueryClient } from '@tanstack/react-query'
import { renameNote } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { RenameNoteInput, RenameNoteResult } from '../api/notes.js'

export function useRenameNote(vaultId: string) {
  const queryClient = useQueryClient()
  return useMutation<RenameNoteResult, ApiError, RenameNoteInput>({
    mutationFn: (input) => renameNote(vaultId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vault-tree', vaultId] })
    },
  })
}
