// #408 item 73: a write to a live document changes only the characters that
// differ (text-diff.ts), never delete-all + insert-all.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyTextDiff, diffText } from '../src/sync/text-diff.js'

/** Applies the diff to a Y.Text holding `from` and returns the result. */
function viaYjs(from: string, to: string, timeLimitMs?: number): string {
  const doc = new Y.Doc()
  const text = doc.getText('body')
  text.insert(0, from)
  doc.transact(() => applyTextDiff(text, to, timeLimitMs))
  return text.toString()
}

/** A deterministic pseudo-random generator, so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('diffText', () => {
  it('changes only what differs', () => {
    expect(diffText('same', 'same')).toEqual([])
    expect(diffText('Para one.\n\nPara two.\n', 'Para one.\n\nPara two.\nAgent line.\n')).toEqual([{ at: 21, remove: 0, insert: 'Agent line.\n' }])
    expect(diffText('Para one.\nPara two.\n', 'Para one.\nPara TYPED two.\n')).toEqual([{ at: 15, remove: 0, insert: 'TYPED ' }])
    expect(diffText('a b c', 'a c')).toEqual([{ at: 2, remove: 2, insert: '' }])
    expect(diffText('', 'new')).toEqual([{ at: 0, remove: 0, insert: 'new' }])
    expect(diffText('old', '')).toEqual([{ at: 0, remove: 3, insert: '' }])
  })

  it('never splits a surrogate pair', () => {
    // 👍 and 👎 share their high surrogate; a UTF-16 diff would change only the low one.
    const edits = diffText('vote 👍 done', 'vote 👎 done')
    expect(edits).toEqual([{ at: 5, remove: 2, insert: '👎' }])
    expect(viaYjs('a😀b\n😀\n', 'a😁b\n😀😀\n')).toBe('a😁b\n😀😀\n')
  })

  it('turns any text into any other, within the time limit or past it', () => {
    const random = rng(408)
    const alphabet = ['a', 'b', 'c', ' ', '\n', '😀', 'é']
    const pick = (n: number): string => Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
    for (let i = 0; i < 400; i++) {
      const from = pick(Math.floor(random() * 60))
      // Mostly small edits of `from`, sometimes an unrelated text.
      let to = from
      if (random() < 0.2) to = pick(Math.floor(random() * 60))
      else {
        for (let e = 0; e < 1 + Math.floor(random() * 4); e++) {
          const at = Math.floor(random() * (to.length + 1))
          const cut = Math.floor(random() * 4)
          to = `${to.slice(0, at)}${pick(Math.floor(random() * 4))}${to.slice(at + cut)}`
        }
      }
      expect(viaYjs(from, to), JSON.stringify({ from, to })).toBe(to)
      // A limit already past: the line pass gives up too, and every run takes the paired-lines fallback.
      expect(viaYjs(from, to, -1), JSON.stringify({ from, to, timeLimitMs: -1 })).toBe(to)
      const edits = diffText(from, to)
      // Ascending and separated by unchanged text.
      for (let j = 1; j < edits.length; j++) expect(edits[j]!.at).toBeGreaterThan(edits[j - 1]!.at + edits[j - 1]!.remove)
      const coarse = diffText(from, to, -1)
      for (let j = 1; j < coarse.length; j++) expect(coarse[j]!.at).toBeGreaterThanOrEqual(coarse[j - 1]!.at + coarse[j - 1]!.remove)
    }
  })

  it('edits a 1 MiB body with a small change quickly and minimally', () => {
    const lines = Array.from({ length: 16_384 }, (_, i) => `line ${i} ${'x'.repeat(56)}\n`).join('')
    const changed = lines.replace('line 9000 ', 'line 9000 edited ')
    const start = performance.now()
    const edits = diffText(lines, changed)
    expect(performance.now() - start).toBeLessThan(1000)
    expect(edits).toEqual([{ at: lines.indexOf('line 9000 ') + 'line 9000 '.length, remove: 0, insert: 'edited ' }])
  })

  it('a whole rewrite past the time limit still yields the new text', () => {
    const random = rng(1)
    const text = (n: number): string => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join('')
    const from = text(200_000)
    const to = text(200_000)
    const start = performance.now()
    expect(viaYjs(from, to, 50)).toBe(to)
    expect(performance.now() - start).toBeLessThan(5000)
  })
})

describe('applyTextDiff on a live document', () => {
  // The review's case: a write that changes every line of a 250 KB note
  // (a `- ` before each) is past the character diff's time limit, and the
  // fallback used to replace the whole run, so typing that reached the
  // server after the write, anchored to a deleted character, landed at
  // position 0. Run with the default limit and with one already past.
  for (const timeLimitMs of [undefined, -1]) {
    it(`keeps offline typing in place when every line of a 250 KB note changes (limit ${timeLimitMs ?? 'default'})`, () => {
      const lines = Array.from({ length: 6000 }, (_, i) => `Line ${i} holds a few words of the note, number ${i * 7}.\n`)
      const body = lines.join('')
      expect(body.length).toBeGreaterThan(250_000)
      const server = new Y.Doc()
      server.getText('body').insert(0, body)
      const tab = new Y.Doc()
      Y.applyUpdate(tab, Y.encodeStateAsUpdate(server))
      // Offline: the person types in the middle of line 3000.
      const at = lines.slice(0, 3000).join('').length + 'Line 3000 holds '.length
      tab.getText('body').insert(at, 'TYPED ')
      const next = lines.map((line) => `- ${line}`).join('')
      const edits = diffText(body, next, timeLimitMs)
      // Each line keeps its text: only the `- ` are new.
      expect(edits.reduce((sum, edit) => sum + edit.remove, 0)).toBe(0)
      server.transact(() => applyTextDiff(server.getText('body'), next, timeLimitMs))
      Y.applyUpdate(server, Y.encodeStateAsUpdate(tab))
      Y.applyUpdate(tab, Y.encodeStateAsUpdate(server))
      const expected = lines.map((line, i) => `- ${i === 3000 ? line.replace('holds ', 'holds TYPED ') : line}`).join('')
      expect(server.getText('body').toString().startsWith('TYPED')).toBe(false)
      expect(server.getText('body').toString()).toBe(expected)
      expect(tab.getText('body').toString()).toBe(expected)
    })
  }

  it('the fallback pairs lines when a run has more on one side', () => {
    expect(diffText('a1\nb1\n', 'xa1\nxb1\nnew\n', -1)).toEqual([
      { at: 0, remove: 0, insert: 'x' },
      { at: 3, remove: 0, insert: 'x' },
      { at: 6, remove: 0, insert: 'new\n' },
    ])
    expect(viaYjs('a1\nb1\nc1\n', 'a2\n', -1)).toBe('a2\n')
  })

  it('keeps a concurrent edit outside the changed region where it was typed', () => {
    const server = new Y.Doc()
    server.getText('body').insert(0, 'Para one.\n\nPara two.\n')
    const tab = new Y.Doc()
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(server))
    // The person types; the server writes before it has their update.
    tab.getText('body').insert('Para one.\n\nPara '.length, 'TYPED ')
    server.transact(() => applyTextDiff(server.getText('body'), 'Para one.\n\nPara two.\nAgent line.\n'))
    Y.applyUpdate(server, Y.encodeStateAsUpdate(tab))
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(server))
    expect(server.getText('body').toString()).toBe('Para one.\n\nPara TYPED two.\nAgent line.\n')
    expect(tab.getText('body').toString()).toBe(server.getText('body').toString())
  })
})
