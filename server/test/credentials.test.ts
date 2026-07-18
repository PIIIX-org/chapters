import { describe, expect, it } from 'vitest'
import { decryptCredential, encryptCredential } from '../src/repositories/credentials.js'

describe('credential encryption', () => {
  it('round-trips', () => {
    const blob = encryptCredential('ghp_supersecrettoken')
    expect(decryptCredential(blob)).toBe('ghp_supersecrettoken')
  })

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const a = encryptCredential('same-secret')
    const b = encryptCredential('same-secret')
    expect(a).not.toBe(b)
    expect(decryptCredential(a)).toBe('same-secret')
    expect(decryptCredential(b)).toBe('same-secret')
  })

  it('rejects a tampered blob', () => {
    const blob = encryptCredential('secret')
    const [iv, authTag, ciphertext] = blob.split(':')
    const tampered = [iv, authTag, ciphertext!.slice(0, -2) + '00'].join(':')
    expect(() => decryptCredential(tampered)).toThrow()
  })
})
