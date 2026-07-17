import nodemailer from 'nodemailer'
import { config } from '../config.js'

export interface Mail {
  to: string
  subject: string
  text: string
}

/** In dev/test (no SMTP configured) mails are recorded here instead of sent. */
export const sentMails: Mail[] = []

const transport = config.smtp
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
    })
  : null

export async function sendMail(mail: Mail): Promise<void> {
  if (!transport) {
    sentMails.push(mail)
    return
  }
  await transport.sendMail({ from: config.smtp?.from, ...mail })
}
