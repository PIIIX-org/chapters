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
  /** Overrides the mail subject/body only; the feed row keeps `message`. */
  emailSubject?: string
  emailText?: string
}): Promise<void> {
  const { emailSubject, emailText, ...row } = input
  await db.insert(notifications).values(row)
  const recipient = await db
    .select({ email: users.email, emailNotifications: users.emailNotifications })
    .from(users)
    .where(eq(users.id, input.recipientId))
    .limit(1)
  const email = recipient[0]?.email
  if (email && recipient[0]!.emailNotifications) {
    void sendMail({
      to: email,
      subject: emailSubject ?? `Chapters: ${input.type.replaceAll('_', ' ')}`,
      text: emailText ?? input.message,
    }).catch(() => {})
  }
}
