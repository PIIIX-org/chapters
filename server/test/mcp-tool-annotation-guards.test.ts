// The two registration guards on tool annotations (#434): a read tool can't
// declare `destructive` or `idempotent` (those describe writes), and a write
// named for deleting, purging, revoking or removing must declare `destructive`.
// Its own file: it imports `toolAnnotations`, which the base doesn't export.
import { describe, expect, it } from 'vitest'
import { toolAnnotations } from '../src/mcp/server.js'

describe('tool annotation guards (#434)', () => {
  it('refuses destructive or idempotent on a read tool', () => {
    expect(() => toolAnnotations('list_things', { capability: 'read', destructive: true })).toThrow(/list_things reads/)
    expect(() => toolAnnotations('list_things', { capability: 'read', idempotent: true })).toThrow(/list_things reads/)
    expect(toolAnnotations('list_things', { capability: 'read' })).toEqual({ readOnlyHint: true })
  })

  it('refuses a delete, purge, revoke or remove tool that does not declare destructive', () => {
    for (const name of ['delete_thing', 'purge_thing', 'revoke_thing', 'remove_thing']) {
      expect(() => toolAnnotations(name, { capability: 'write' })).toThrow(`MCP tool ${name} must declare destructive`)
      expect(toolAnnotations(name, { capability: 'admin', destructive: true })).toEqual({ destructiveHint: true })
    }
    expect(toolAnnotations('rename_thing', { capability: 'write', idempotent: true })).toEqual({ destructiveHint: false, idempotentHint: true })
  })
})
