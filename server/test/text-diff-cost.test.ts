// #833: since #807 a whole-body write ran the character diff over the whole
// body until the 100 ms limit, then a second 100 ms for the line pass, and
// cut an unrelated rewrite into thousands of fragments; every write held the
// event loop that long. Budgets here are several times the measured cost (a
// few ms on an M-series laptop) and well under what the old diff took.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyTextDiff, DIFF_TIME_LIMIT_MS, diffText, type TextEdit } from '../src/sync/text-diff.js'

/**
 * A deterministic markdown note of about `bytes` units: lines of `words` to
 * twice that many random words, with a heading every 12 lines unless
 * `headings` is false (shared headings anchor a line diff into small runs).
 */
function note(bytes: number, seed: number, words = 8, headings = true): string {
  const vocabulary = ['vault', 'note', 'graph', 'index', 'revision', 'collab', 'crash', 'durable', 'atomic', 'rename', 'fsync', 'yjs', 'agent', 'search']
  let s = seed >>> 0
  const random = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
  const out: string[] = []
  let length = 0
  for (let line = 0; length < bytes; line++) {
    const heading = headings && line % 12 === 0 ? `## Section ${line / 12}\n` : ''
    const n = words + Math.floor(random() * words)
    const text = `${heading}${Array.from({ length: n }, () => vocabulary[Math.floor(random() * vocabulary.length)]).join(' ')}.\n`
    out.push(text)
    length += text.length
  }
  return out.join('')
}

/** The fastest of three runs of `run`, in ms, and its last result. */
function fastest<T>(run: () => T): { ms: number; result: T } {
  let ms = Infinity
  let result!: T
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    result = run()
    ms = Math.min(ms, performance.now() - start)
  }
  return { ms, result }
}

/** `from` with `edits` (ascending, apart) applied, built in one pass: a 1 MB body takes 14,000 edits. */
function applied(from: string, edits: readonly TextEdit[]): string {
  const parts: string[] = []
  let last = 0
  for (const { at, remove, insert } of edits) {
    parts.push(from.slice(last, at), insert)
    last = at + remove
  }
  parts.push(from.slice(last))
  return parts.join('')
}

describe('diffText cost (#833)', () => {
  it('a 40 KB note with one paragraph changed: under 10 ms, only the changed words', () => {
    const body = note(40_000, 1)
    const lines = body.split('\n')
    const at = Math.floor(lines.length / 2)
    lines[at] = lines[at]!.replace(/^(\w+) (\w+)/, '$1 EDITED').replace(/(\w+)\.$/, 'CHANGED.')
    const next = lines.join('\n')
    const { ms, result } = fastest(() => diffText(body, next))
    expect(applied(body, result)).toBe(next)
    expect(result.reduce((sum, edit) => sum + edit.insert.length, 0)).toBe('EDITED'.length + 'CHANGED'.length)
    expect(ms).toBeLessThan(10)
  })

  it('an append or a one-line change to a 1 MB note costs a linear scan, not a character diff of the body', () => {
    const body = note(1_000_000, 2)
    const appended = `${body}\nA paragraph the agent added.\n`
    const changed = body.replace('## Section 500\n', '## Section 500, revised\n')
    const append = fastest(() => diffText(body, appended))
    const change = fastest(() => diffText(body, changed))
    expect(append.result).toEqual([{ at: body.length, remove: 0, insert: '\nA paragraph the agent added.\n' }])
    expect(change.result).toEqual([{ at: body.indexOf('## Section 500\n') + '## Section 500'.length, remove: 0, insert: ', revised' }])
    expect(append.ms).toBeLessThan(20)
    expect(change.ms).toBeLessThan(20)
  })

  it('every line of a 1 MB note changed: well within the time limit, and no character of a line is removed', () => {
    const body = note(1_000_000, 3)
    const next = body
      .split('\n')
      .map((line) => (line === '' ? line : `- ${line}`))
      .join('\n')
    const { ms, result } = fastest(() => diffText(body, next))
    expect(applied(body, result)).toBe(next)
    expect(result.reduce((sum, edit) => sum + edit.remove, 0)).toBe(0)
    expect(ms).toBeLessThan(DIFF_TIME_LIMIT_MS / 2)
  })

  it('an unrelated rewrite of a 40 KB note (the lab crash-write round) is a few ms and at most one change per line', () => {
    const body = note(40_000, 4)
    const next = note(40_000, 5)
    const { ms, result } = fastest(() => diffText(body, next))
    expect(applied(body, result)).toBe(next)
    // A character diff of unrelated text cuts it into thousands of fragments (5,000+ before #833).
    expect(result.length).toBeLessThanOrEqual(body.split('\n').length)
    expect(ms).toBeLessThan(25)
    // The live document stays about the size of the text, not five times it.
    const doc = new Y.Doc()
    doc.getText('body').insert(0, body)
    const apply = fastest(() => {
      const live = new Y.Doc()
      Y.applyUpdate(live, Y.encodeStateAsUpdate(doc))
      live.transact(() => applyTextDiff(live.getText('body'), next))
      return live
    })
    expect(apply.result.getText('body').toString()).toBe(next)
    expect(Y.encodeStateAsUpdate(apply.result).length).toBeLessThan(2 * (body.length + next.length))
    expect(apply.ms).toBeLessThan(100)
  })

  // Review round 3: a short line paired with a long unrelated one counted as
  // alike (most of the short one is a scattered subsequence of the long one),
  // and the character diff cut it into hundreds of fragments.
  for (const [from, to] of [
    [8, 80],
    [80, 8],
  ]) {
    it(`an unrelated rewrite of a 40 KB note from lines of ${from}+ words to lines of ${to}+ words is about one change per line`, () => {
      const body = note(40_000, 6, from)
      const next = note(40_000, 7, to)
      const result = diffText(body, next)
      expect(applied(body, result)).toBe(next)
      expect(result.length).toBeLessThanOrEqual(2 * Math.min(body.split('\n').length, next.split('\n').length) + 2)
      const live = new Y.Doc()
      live.getText('body').insert(0, body)
      live.transact(() => applyTextDiff(live.getText('body'), next))
      expect(Y.encodeStateAsUpdate(live).length).toBeLessThan(1.5 * (body.length + next.length))
    })
  }

  // Review round 4: with no shared line to anchor it, a rewrite that changes
  // the line count is one run, and aligning it tried every shift: 45,000 to
  // 160,000 lines × shifts at several µs each ran into the time limit, and
  // then every pair was trimmed to its common ends.
  for (const [from, to] of [
    [8, 40],
    [4, 24],
  ]) {
    it(`a rewrite of a 40 KB note from lines of ${from}+ words to lines of ${to}+ words, with no line in common, stays well within the time limit`, () => {
      const body = note(40_000, 8, from, false)
      const next = note(40_000, 9, to, false)
      const [a, b] = [body.split('\n').length, next.split('\n').length]
      expect((Math.abs(a - b) + 1) * Math.min(a, b)).toBeGreaterThan(2 ** 15)
      const { ms, result } = fastest(() => diffText(body, next))
      expect(applied(body, result)).toBe(next)
      expect(result.length).toBeLessThanOrEqual(2 * Math.min(a, b) + 2)
      expect(ms).toBeLessThan(DIFF_TIME_LIMIT_MS / 2)
    })
  }
})
