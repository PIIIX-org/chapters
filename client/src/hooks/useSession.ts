import { useQuery } from '@tanstack/react-query'
import { getSession } from '../api/auth.js'
import type { ApiError } from '../lib/api.js'
import type { SessionUser } from '../api/auth.js'

export const SESSION_QUERY_KEY = ['session'] as const

export function useSession() {
  return useQuery<SessionUser, ApiError>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: getSession,
    retry: false,
  })
}
