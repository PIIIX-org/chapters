import { apiFetch, ApiError } from '../lib/api.js'

export interface Notification {
  id: string
  recipientId: string
  type: string
  entityType: string | null
  entityId: string | null
  message: string
  readAt: string | null
  createdAt: string
}

export function listNotifications(limit = 50, offset = 0): Promise<Notification[]> {
  return apiFetch(`/notifications?limit=${limit}&offset=${offset}`)
}

export async function markNotificationRead(id: string): Promise<{ status: 'read' }> {
  try {
    return await apiFetch(`/notifications/${id}/read`, { method: 'POST' })
  } catch (err) {
    // Server 404s both for "not yours" and "already read" (it updates only
    // WHERE read_at IS NULL) — swallow so a double-click doesn't surface an error.
    if (err instanceof ApiError && err.status === 404) return { status: 'read' }
    throw err
  }
}
