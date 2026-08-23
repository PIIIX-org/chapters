import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listNotifications, markNotificationRead } from '../api/notifications.js'
import type { Notification } from '../api/notifications.js'
import type { ApiError } from '../lib/api.js'

export const NOTIFICATIONS_QUERY_KEY = ['notifications'] as const

// ponytail: no polling — react-query's refetch-on-focus is enough. Unread
// count is derived from this fetched page, so it caps at `limit` (default 50);
// add polling or a server-side unread-count endpoint if that ceiling matters.
export function useNotifications() {
  return useQuery<Notification[], ApiError>({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: () => listNotifications(),
  })
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'read' }, ApiError, string>({
    mutationFn: (id) => markNotificationRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY, exact: true })
    },
  })
}
