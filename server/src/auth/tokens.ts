import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function tokensEqual(a: string, b: string): boolean {
  const ha = Buffer.from(hashToken(a))
  const hb = Buffer.from(hashToken(b))
  return timingSafeEqual(ha, hb)
}
