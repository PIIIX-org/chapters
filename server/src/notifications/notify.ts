import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notifications, users } from '../db/schema.js'
import { sendMail } from '../email/mailer.js'

/**
 * Writes an in-app notification and sends its email. The in-app row is always
 * written — it is the activity feed, and the notifications spec depends on it
 * as a historical record. Only the email honours the recipient's opt-out.
 * Email is best-effort.
 */
export async function notify(input: {
  recipientId: string
  type: string
  message: string
  entityType?: string
  entityId?: string
}): Promise<void> {
  await db.insert(notifications).values(input)
  const recipient = await db
    .select({ email: users.email, emailNotifications: users.emailNotifications })
    .from(users)
    .where(eq(users.id, input.recipientId))
    .limit(1)
  const email = recipient[0]?.email
  if (email && recipient[0]!.emailNotifications) {
    void sendMail({
      to: email,
      subject: `Chapters: ${input.type.replaceAll('_', ' ')}`,
      text: input.message,
    }).catch(() => {})
  }
}
