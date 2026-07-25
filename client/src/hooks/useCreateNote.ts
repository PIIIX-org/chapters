import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createNote } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { CreateNoteInput, CreateNoteResult } from '../api/notes.js'

export function useCreateNote(vaultId: string) {
  const queryClient = useQueryClient()
  return useMutation<CreateNoteResult, ApiError, CreateNoteInput>({
    mutationFn: (input) => createNote(vaultId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vault-tree', vaultId] })
    },
  })
}
