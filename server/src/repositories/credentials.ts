import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../config.js'

export class EncryptionKeyMissingError extends Error {
  constructor() {
    super(
      'CREDENTIALS_ENCRYPTION_KEY is not configured — required for private repo credentials and webhook secrets',
    )
  }
}

function key(): Buffer {
  if (!config.credentialsEncryptionKey) throw new EncryptionKeyMissingError()
  const buf = Buffer.from(config.credentialsEncryptionKey, 'hex')
  if (buf.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (64 hex characters)')
  }
  return buf
}

/** AES-256-GCM: authenticated encryption — tampering fails decryption, not just detection. */
export function encryptCredential(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':')
}

export function decryptCredential(blob: string): string {
  const [ivHex, authTagHex, ciphertextHex] = blob.split(':')
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('malformed credential blob')
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}
