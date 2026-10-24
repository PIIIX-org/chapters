import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { restBytes } from './noteSize.js'

/** A v1 update setting the string map entry `key` on the root `root` (client 77, clock 0): see server/test/collab-size.test.ts. */
function mapEntryOnRoot(root: string, key: string, text: string): Uint8Array {
  const enc = new TextEncoder()
  const varUint = (n: number): number[] => {
    const out: number[] = []
    while (n > 0x7f) {
      out.push(0x80 | (n & 0x7f))
      n = Math.floor(n / 128)
    }
    out.push(n)
    return out
  }
  const varString = (s: string): number[] => {
    const bytes = [...enc.encode(s)]
    return [...varUint(bytes.length), ...bytes]
  }
  return Uint8Array.from([1, 1, 77, 0, 4 | 0x20, 1, ...varString(root), ...varString(key), ...varString(text), 0])
}

describe('restBytes (the editor mirror of the relay measure)', () => {
  it('leaves the body text out', () => {
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'typed text')
    expect(restBytes(doc)).toBe(0)
  })

  // #952: neither measure counted a string map entry on the body root.
  it('counts a string map entry on the body root, as the relay does', () => {
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'typed text')
    Y.applyUpdate(doc, mapEntryOnRoot('body', 'k', 'x'.repeat(5000)))
    expect(doc.getText('body').toString()).toBe('typed text')
    expect(restBytes(doc)).toBe(5001)
  })
})
