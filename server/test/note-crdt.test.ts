import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { SERVER_CLIENT_ID, compileChange, cloneDocument } from '../src/sync/live-docs.js'
import { seedClientId, seedDocument } from '../src/sync/note-crdt.js'
import { mergeTextKeepingTheirs } from '../src/sync/three-way-merge.js'

// ADR-003 §5.4 "Seed": a note with no CRDT state is seeded deterministically,
// and only identical input shares a lineage.

const NOTE = '6f1c1c4e-2a43-4d51-9a0e-7b7f2b0c9e11'
const STATE = { frontmatter: { type: 'docs', title: 'Seed', tags: ['a', 'b'] }, body: 'Seeded body.\n' }

describe('deterministic seed (§5.4)', () => {
  it('identical input gives byte-identical seeds, which merge item for item', () => {
    const a = Y.encodeStateAsUpdate(seedDocument(NOTE, STATE))
    const b = Y.encodeStateAsUpdate(seedDocument(NOTE, { frontmatter: { tags: ['a', 'b'], title: 'Seed', type: 'docs' }, body: STATE.body }))
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    const merged = new Y.Doc()
    Y.applyUpdate(merged, a)
    Y.applyUpdate(merged, b)
    expect(merged.getText('body').toString()).toBe(STATE.body)
  })

  it('the same body with other frontmatter, or another note, gets another client id', () => {
    const id = seedClientId(NOTE, STATE)
    expect(seedClientId(NOTE, { ...STATE, frontmatter: { ...STATE.frontmatter, title: 'Other' } })).not.toBe(id)
    expect(seedClientId('0d6d6d70-1111-4c4c-8888-000000000000', STATE)).not.toBe(id)
    expect(seedClientId(NOTE, { ...STATE, body: 'Other body.\n' })).not.toBe(id)
  })

  it('the seed id authors nothing after the seed: later changes carry the server process id', () => {
    const doc = seedDocument(NOTE, STATE)
    expect(doc.clientID).toBe(SERVER_CLIENT_ID)
    const update = compileChange(cloneDocument(doc), { frontmatter: STATE.frontmatter, body: 'Seeded body, edited.\n' })
    const authors = new Set(Y.decodeUpdate(update).structs.map((s) => s.id.client))
    expect([...authors]).toEqual([SERVER_CLIENT_ID])
  })
})

describe('rebase merge (§5.4): an overlap keeps the CRDT side', () => {
  it('keeps changes on both sides that do not overlap', () => {
    expect(mergeTextKeepingTheirs('a\nb\nc\n', 'a\nb\nc\ntyped\n', 'A\nb\nc\n')).toEqual({ text: 'A\nb\nc\ntyped\n', overlaps: [] })
  })

  it('keeps the typing where both changed the same line, and reports the overlap', () => {
    const merged = mergeTextKeepingTheirs('a\nb\n', 'a typed\nb\n', 'a by sql\nb\n')
    expect(merged.text).toBe('a typed\nb\n')
    expect(merged.overlaps).toHaveLength(1)
  })
})
