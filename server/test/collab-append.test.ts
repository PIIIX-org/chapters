import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { liveTookUpdate, updateToLog } from '../src/sync/collab-append.js'

// ADR-003 §5.4 Append steps 1-2 (S3): what the relay logs before it acks.

function pair(body: string): { live: Y.Doc; client: Y.Doc } {
  const live = new Y.Doc()
  live.getText('body').insert(0, body)
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(live))
  return { live, client }
}

function edit(client: Y.Doc, change: (text: Y.Text) => void): Uint8Array {
  const before = Y.encodeStateVector(client)
  change(client.getText('body'))
  return Y.encodeStateAsUpdate(client, before)
}

describe('updateToLog', () => {
  it('refuses bytes that do not decode, or decode and do not apply', () => {
    const { live, client } = pair('text')
    const update = edit(client, (t) => t.insert(0, 'new '))
    expect(() => updateToLog(live, update.slice(0, update.length - 3))).toThrow()
    expect(() => updateToLog(live, new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f, 1, 2, 3]))).toThrow()
  })

  it('logs nothing for an update the document already holds (a reconnect repeating known items)', () => {
    const { live, client } = pair('text')
    const update = edit(client, (t) => t.insert(0, 'new '))
    Y.applyUpdate(live, update)
    expect(updateToLog(live, update)).toBeNull()
    expect(updateToLog(live, Y.encodeStateAsUpdate(client))).toBeNull()
  })

  it('logs only what the document lacks', () => {
    const { live, client } = pair('text')
    const known = edit(client, (t) => t.insert(0, 'known '))
    Y.applyUpdate(live, known)
    edit(client, (t) => t.insert(t.length, ' fresh'))
    const logged = updateToLog(live, Y.encodeStateAsUpdate(client))!
    expect(logged).not.toBeNull()
    expect(logged.byteLength).toBeLessThan(Y.encodeStateAsUpdate(client).byteLength)
    Y.applyUpdate(live, logged)
    expect(live.getText('body').toString()).toBe('known text fresh')
  })
})

describe('liveTookUpdate', () => {
  it('is true once the document applied the update, false before', () => {
    const { live, client } = pair('text')
    const update = edit(client, (t) => t.insert(0, 'new '))
    expect(liveTookUpdate(live, update)).toBe(false)
    Y.applyUpdate(live, update)
    expect(liveTookUpdate(live, update)).toBe(true)
  })
})
