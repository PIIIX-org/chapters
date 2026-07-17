import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notifications, users } from '../db/schema.js'
import { sendMail } from '../email/mailer.js'

/**
 * Writes an in-app notification and sends its email — one write path, two
 * delivery side-effects, always (notifications spec). Email is best-effort.
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
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, input.recipientId))
    .limit(1)
  const email = recipient[0]?.email
  if (email) {
    void sendMail({
      to: email,
      subject: `Chapters: ${input.type.replaceAll('_', ' ')}`,
      text: input.message,
    }).catch(() => {})
  }
}
