import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateNote } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { UpdateNoteInput, UpdateNoteResult } from '../api/notes.js'

export function useUpdateNote(vaultId: string, path: string) {
  const queryClient = useQueryClient()
  return useMutation<UpdateNoteResult, ApiError, UpdateNoteInput>({
    mutationFn: (input) => updateNote(vaultId, path, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['note', vaultId, path] })
    },
  })
}
