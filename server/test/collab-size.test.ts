import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { bodyMeasured, updateFits } from '../src/sync/collab-size.js'

const LIMIT = 1000
/** Serializing the body is the whole-document work the guard must keep off ordinary keystrokes (vi.spyOn's key type leaves out `toString`). */
const textPrototype: { toString(): string } = Y.Text.prototype

/** A server-side document holding `body`, and a client that shares its history. */
function pair(body: string): { server: Y.Doc; client: Y.Doc } {
  const server = new Y.Doc()
  server.getText('body').insert(0, body)
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
  return { server, client }
}

/** The update `edit` makes on the client, as the relay would receive it. */
function updateFrom(client: Y.Doc, edit: (text: Y.Text) => void): Uint8Array {
  const before = Y.encodeStateVector(client)
  edit(client.getText('body'))
  return Y.encodeStateAsUpdate(client, before)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('collab size guard (#491)', () => {
  it('lets keystrokes far from the cap through without serializing the note', () => {
    const { server, client } = pair('x'.repeat(100))
    expect(updateFits(server, updateFrom(client, (t) => t.insert(0, 'a')), LIMIT)).toBe(true)
    const toString = vi.spyOn(textPrototype, 'toString')
    for (let i = 0; i < 50; i++) {
      const update = updateFrom(client, (t) => t.insert(t.length, 'k'))
      expect(updateFits(server, update, LIMIT)).toBe(true)
      Y.applyUpdate(server, update)
    }
    expect(toString).not.toHaveBeenCalled()
  })

  it('refuses an update that would take the body past the cap, counting UTF-8 bytes', () => {
    const { server, client } = pair('x'.repeat(900))
    // 60 characters, 120 bytes: 1020 bytes after.
    expect(updateFits(server, updateFrom(client, (t) => t.insert(0, 'é'.repeat(60))), LIMIT)).toBe(false)
    expect(server.getText('body').toString()).toBe('x'.repeat(900))
  })

  it('accepts a replacement that ends at the cap, though the update is larger than the room left', () => {
    const { server, client } = pair('x'.repeat(900))
    const update = updateFrom(client, (t) => {
      t.delete(0, t.length)
      t.insert(0, 'y'.repeat(LIMIT))
    })
    expect(updateFits(server, update, LIMIT)).toBe(true)
  })

  it('takes the exact measure again once the bound is used up, so a shrunk note has its room back', () => {
    const { server, client } = pair('x'.repeat(900))
    const shrink = updateFrom(client, (t) => t.delete(0, 800))
    expect(updateFits(server, shrink, LIMIT)).toBe(true)
    Y.applyUpdate(server, shrink)
    expect(updateFits(server, updateFrom(client, (t) => t.insert(0, 'z'.repeat(800))), LIMIT)).toBe(true)
  })

  it('restarts the bound from the body the store serialized', () => {
    const { server, client } = pair('x'.repeat(10))
    for (let i = 0; i < 30; i++) {
      const update = updateFrom(client, (t) => t.insert(t.length, 'k'))
      expect(updateFits(server, update, LIMIT)).toBe(true)
      Y.applyUpdate(server, update)
    }
    bodyMeasured(server, server.getText('body').toString())
    const toString = vi.spyOn(textPrototype, 'toString')
    expect(updateFits(server, updateFrom(client, (t) => t.insert(0, 'q'.repeat(900))), LIMIT)).toBe(true)
    expect(toString).not.toHaveBeenCalled()
  })

  it('lets a note already over the cap shrink and take frontmatter, but not new text', () => {
    const { server, client } = pair('x'.repeat(LIMIT + 50))
    const shrink = updateFrom(client, (t) => t.delete(0, 10))
    expect(updateFits(server, shrink, LIMIT)).toBe(true)
    Y.applyUpdate(server, shrink)
    const before = Y.encodeStateVector(client)
    client.getMap('frontmatter').set('title', 'Still big')
    const frontmatter = Y.encodeStateAsUpdate(client, before)
    expect(updateFits(server, frontmatter, LIMIT)).toBe(true)
    Y.applyUpdate(server, frontmatter)
    expect(updateFits(server, updateFrom(client, (t) => t.insert(0, 'more')), LIMIT)).toBe(false)
  })

  it('lets a note over the cap take new text when the same update cuts more than it adds', () => {
    const { server, client } = pair('x'.repeat(LIMIT + 50))
    const update = updateFrom(client, (t) => {
      t.insert(0, 'new')
      t.delete(10, 20)
    })
    expect(updateFits(server, update, LIMIT)).toBe(true)
    Y.applyUpdate(server, update)
    // Adding as much as it cuts leaves it no larger: also allowed.
    const level = updateFrom(client, (t) => {
      t.insert(0, 'abcde')
      t.delete(10, 5)
    })
    expect(updateFits(server, level, LIMIT)).toBe(true)
    Y.applyUpdate(server, level)
    const grows = updateFrom(client, (t) => {
      t.insert(0, 'abcdef')
      t.delete(10, 5)
    })
    expect(updateFits(server, grows, LIMIT)).toBe(false)
  })

  it('counts text held pending that an update would unblock', () => {
    const server = new Y.Doc()
    const client = new Y.Doc()
    const first = updateFrom(client, (t) => t.insert(0, 'a'.repeat(600)))
    const second = updateFrom(client, (t) => t.insert(t.length, 'b'.repeat(600)))
    // The second arrives first: Yjs holds it pending, nothing is in the body yet.
    expect(updateFits(server, second, LIMIT)).toBe(true)
    Y.applyUpdate(server, second)
    expect(server.getText('body').length).toBe(0)
    expect(updateFits(server, first, LIMIT)).toBe(false)
  })
})

/** The update `edit` makes on the client's whole document (frontmatter, other roots), as the relay would receive it. */
function docUpdateFrom(client: Y.Doc, edit: (doc: Y.Doc) => void): Uint8Array {
  const before = Y.encodeStateVector(client)
  edit(client)
  return Y.encodeStateAsUpdate(client, before)
}

// #780: the body was the only thing bounded; frontmatter and any other content in the document were not.
describe('collab size guard: the rest of the document (#780)', () => {
  it('refuses a frontmatter value that would take the rest of the document past the cap', () => {
    const { server, client } = pair('short body')
    const update = docUpdateFrom(client, (doc) => doc.getMap('frontmatter').set('huge', 'f'.repeat(LIMIT)))
    expect(updateFits(server, update, LIMIT)).toBe(false)
  })

  it('refuses frontmatter that passes the cap over many keys, each one far under it', () => {
    const { server, client } = pair('short body')
    let refused = -1
    for (let i = 0; i < 20; i++) {
      const update = docUpdateFrom(client, (doc) => doc.getMap('frontmatter').set(`k${i}`, 'v'.repeat(100)))
      if (!updateFits(server, update, LIMIT)) {
        refused = i
        break
      }
      Y.applyUpdate(server, update)
    }
    // Nine or so values of about 106 bytes (key, quotes, value) fit; the next would pass 1000.
    expect(refused).toBeGreaterThanOrEqual(8)
    expect(refused).toBeLessThanOrEqual(10)
    expect(server.getMap('frontmatter').size).toBe(refused)
  })

  it('counts JSON values by what they take written out, not by their compact encoding', () => {
    const { server, client } = pair('')
    // 400 `false`s encode in about 400 bytes and are 2400 as JSON.
    const update = docUpdateFrom(client, (doc) => doc.getMap('frontmatter').set('flags', Array.from({ length: 400 }, () => false)))
    expect(update.length).toBeLessThan(LIMIT)
    expect(updateFits(server, update, LIMIT)).toBe(false)
  })

  it('refuses content in other root types and non-text content in the body', () => {
    const map = pair('body')
    expect(updateFits(map.server, docUpdateFrom(map.client, (doc) => doc.getMap('junk').set('k', 'j'.repeat(LIMIT))), LIMIT)).toBe(false)
    const text = pair('body')
    expect(updateFits(text.server, docUpdateFrom(text.client, (doc) => doc.getText('junk').insert(0, 'j'.repeat(LIMIT + 1))), LIMIT)).toBe(false)
    const array = pair('body')
    expect(updateFits(array.server, docUpdateFrom(array.client, (doc) => doc.getArray('junk').insert(0, [new Uint8Array(LIMIT + 1)])), LIMIT)).toBe(false)
    const embed = pair('body')
    expect(updateFits(embed.server, updateFrom(embed.client, (t) => t.insertEmbed(0, { blob: 'e'.repeat(LIMIT) })), LIMIT)).toBe(false)
    const format = pair('body')
    expect(updateFits(format.server, updateFrom(format.client, (t) => t.format(0, 4, { style: 's'.repeat(LIMIT) })), LIMIT)).toBe(false)
  })

  it('keeps the body and the rest apart: a body at the cap still takes small frontmatter', () => {
    const { server, client } = pair('x'.repeat(LIMIT))
    const update = docUpdateFrom(client, (doc) => doc.getMap('frontmatter').set('title', 'At the cap'))
    expect(updateFits(server, update, LIMIT)).toBe(true)
  })

  it('lets a document whose rest is already over the cap shrink, but not grow', () => {
    const server = new Y.Doc()
    server.getText('body').insert(0, 'body')
    server.getMap('frontmatter').set('big', 'b'.repeat(LIMIT + 50))
    server.getMap('frontmatter').set('small', 'kept')
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
    const shrink = docUpdateFrom(client, (doc) => doc.getMap('frontmatter').delete('small'))
    expect(updateFits(server, shrink, LIMIT)).toBe(true)
    Y.applyUpdate(server, shrink)
    expect(updateFits(server, docUpdateFrom(client, (doc) => doc.getMap('frontmatter').set('more', 'm')), LIMIT)).toBe(false)
    // Body typing does not grow the rest: still taken.
    expect(updateFits(server, updateFrom(client, (t) => t.insert(0, 'typing ')), LIMIT)).toBe(true)
  })

  it('lets frontmatter edits far from the cap through without measuring the document', () => {
    const { server, client } = pair('x'.repeat(100))
    const primer = docUpdateFrom(client, (doc) => doc.getMap('frontmatter').set('title', 'first'))
    expect(updateFits(server, primer, LIMIT)).toBe(true)
    Y.applyUpdate(server, primer)
    const toString = vi.spyOn(textPrototype, 'toString')
    const toJSON = vi.spyOn(Y.Map.prototype, 'toJSON')
    for (let i = 0; i < 5; i++) {
      const update = docUpdateFrom(client, (doc) => doc.getMap('frontmatter').set('title', `t${i}`))
      expect(updateFits(server, update, LIMIT)).toBe(true)
      Y.applyUpdate(server, update)
    }
    expect(toString).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
  })
})

/** A server document whose frontmatter is already over the cap (stored before #780, or by an unbounded REST/MCP merge), and a client sharing it. */
function overCapFrontmatter(): { server: Y.Doc; client: Y.Doc } {
  const server = new Y.Doc()
  server.getText('body').insert(0, 'the body of a note whose properties are too large')
  server.getText('junk').insert(0, 'other root')
  server.getMap('frontmatter').set('big', 'b'.repeat(LIMIT + 200))
  server.getMap('frontmatter').set('title', 'Over')
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
  return { server, client }
}

// #947: on such a note every update, plain typing included, measured the whole rest and built a scratch copy.
describe('collab size guard: updates that add nothing to the rest (#947)', () => {
  /** The rest is measured item by item; a frontmatter value's content is read through getContent. */
  const contentPrototype: { getContent(): unknown[] } = Y.ContentAny.prototype

  it('lets body typing through without measuring the rest, wherever it is typed', () => {
    const { server, client } = overCapFrontmatter()
    // The first check sets up the document's meter (one measure at load).
    const first = updateFrom(client, (t) => t.insert(t.length, '.'))
    expect(updateFits(server, first, LIMIT)).toBe(true)
    Y.applyUpdate(server, first)

    const getContent = vi.spyOn(contentPrototype, 'getContent')
    const edits: Array<(t: Y.Text) => void> = [
      (t) => t.insert(0, 'start '),
      (t) => t.insert(10, 'middle '),
      (t) => t.insert(t.length, ' end'),
      (t) => {
        t.insert(3, 'two ')
        t.insert(t.length, ' places')
      },
      (t) => t.delete(0, 6),
    ]
    for (const edit of edits) {
      const update = updateFrom(client, edit)
      expect(updateFits(server, update, LIMIT)).toBe(true)
      Y.applyUpdate(server, update)
    }
    expect(getContent).not.toHaveBeenCalled()
    expect(server.getText('body').toString()).toBe(client.getText('body').toString())
  })

  it('still refuses an update that grows the rest: frontmatter, another root typed into, an embed in the body', () => {
    // A fresh pair each time: a refused update is never applied, so the client's next one would wait on it (pending).
    const refused = (edit: (doc: Y.Doc) => void) => {
      const { server, client } = overCapFrontmatter()
      return !updateFits(server, docUpdateFrom(client, edit), LIMIT)
    }
    expect(refused((doc) => doc.getMap('frontmatter').set('more', 'm'))).toBe(true)
    // Typed after an existing character, or before one: the decoded item names no parent, only its origin.
    expect(refused((doc) => doc.getText('junk').insert(5, 'x'))).toBe(true)
    expect(refused((doc) => doc.getText('junk').insert(0, 'x'))).toBe(true)
    expect(refused((doc) => doc.getText('body').insertEmbed(4, { e: 1 }))).toBe(true)
    expect(refused((doc) => doc.getText('body').format(0, 3, { bold: true }))).toBe(true)
    // Body typing in the same update as rest growth.
    expect(
      refused((doc) => {
        doc.getText('body').insert(0, 'typed ')
        doc.getMap('frontmatter').set('more', 'm')
      }),
    ).toBe(true)
    // A text nested in the frontmatter (stored before, like the rest), then typed into after its first character.
    const { server, client } = overCapFrontmatter()
    const nested = new Y.Text('n')
    Y.applyUpdate(server, docUpdateFrom(client, (doc) => doc.getMap('frontmatter').set('nested', nested)))
    expect(updateFits(server, docUpdateFrom(client, () => nested.insert(1, 'more')), LIMIT)).toBe(false)
  })

  it('still refuses body typing that unblocks rest growth Yjs held pending', () => {
    const { server, client } = overCapFrontmatter()
    const typing = updateFrom(client, (t) => t.insert(0, 'typed '))
    const growth = docUpdateFrom(client, (doc) => doc.getMap('frontmatter').set('more', 'm'.repeat(50)))
    // The growth arrives first: Yjs holds it pending, nothing is in the document yet.
    expect(updateFits(server, growth, LIMIT)).toBe(true)
    Y.applyUpdate(server, growth)
    expect(server.getMap('frontmatter').has('more')).toBe(false)
    expect(updateFits(server, typing, LIMIT)).toBe(false)
  })

  it('still lets the rest shrink', () => {
    const { server, client } = overCapFrontmatter()
    expect(updateFits(server, docUpdateFrom(client, (doc) => doc.getMap('frontmatter').delete('title')), LIMIT)).toBe(true)
  })
})
