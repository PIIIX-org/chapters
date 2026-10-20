// The strict-args refusal (#437) must stay a refusal for any key an agent
// sends (#769): a key named `constructor` used to hit Object.prototype in the
// guess table and throw, and every unknown key was echoed with no limit
// (60,000 keys gave a 1.19 MB message).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { strictArgs } from '../src/mcp/strict-input.js'

const schema = strictArgs('read_note', { vaultId: z.string(), path: z.string() })

/** The refusal text for `args`; fails the test if the schema accepts them. */
function refusal(args: Record<string, unknown>): string {
  const result = schema.safeParse({ vaultId: 'v', path: 'p', ...args })
  if (result.success) throw new Error('expected a refusal')
  return result.error.issues.map((issue) => issue.message).join('\n')
}

describe('strict-args refusal limits (#769)', () => {
  it.each(['constructor', 'Constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'a key named %s gets the normal refusal',
    (key) => {
      const args: Record<string, unknown> = {}
      Object.defineProperty(args, key, { value: 1, enumerable: true, configurable: true, writable: true })
      expect(refusal(args)).toBe(`unknown argument "${key}"; read_note takes: vaultId, path`)
    },
  )

  it('10,000 unknown keys give a short refusal, quickly', () => {
    const args: Record<string, unknown> = {}
    for (let i = 0; i < 10_000; i++) args[`unknown${i}`] = i
    const started = performance.now()
    const message = refusal(args)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(Buffer.byteLength(message)).toBeLessThan(1024)
    expect(message).toContain('"unknown0"')
    expect(message).toContain('and 9990 more')
    expect(message).toContain('read_note takes: vaultId, path')
  })

  it('a 1 MB key is truncated and skips the did-you-mean comparison', () => {
    const key = 'x'.repeat(1_000_000)
    const started = performance.now()
    const message = refusal({ [key]: 1 })
    expect(performance.now() - started).toBeLessThan(50)
    expect(Buffer.byteLength(message)).toBeLessThan(1024)
    expect(message).toContain('read_note takes: vaultId, path')
  })

  it('still suggests close names', () => {
    expect(refusal({ vault_id: 'x' })).toContain('"vault_id" (did you mean "vaultId"?)')
    expect(refusal({ file: 'x' })).toContain('"file" (did you mean "path"?)')
  })
})
