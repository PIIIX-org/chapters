import { db } from '../db/client.js'
import { securityEvents } from '../db/schema.js'

export async function logSecurityEvent(event: {
  type: string
  actorUserId?: string
  subjectUserId?: string
  mcpConnectionId?: string
  ip?: string
  detail?: unknown
}): Promise<void> {
  await db.insert(securityEvents).values(event)
}
