// #408 item 73: a write to a live document changes only the characters that
// differ (text-diff.ts), never delete-all + insert-all.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyTextDiff, diffText, type TextEdit } from '../src/sync/text-diff.js'

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

// A limit no loaded CI runner reaches, for tests about what the diff keeps
// rather than how fast it is (text-diff-cost.test.ts holds the budgets): under
// load a pause past the default limit sends a small diff down the coarse path.
const AMPLE_MS = 10_000
const limitName = (timeLimitMs: number): string => (timeLimitMs < 0 ? 'limit already past' : 'ample limit')

/** `from` with `edits` (ascending, apart) applied, as plain strings, in one pass. */
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

/** True when no edit starts or ends inside a surrogate pair of `from`, nor inserts half of one. */
function keepsPairs(from: string, edits: readonly TextEdit[]): boolean {
  const low = (text: string, i: number): boolean => (text.charCodeAt(i) & 0xfc00) === 0xdc00
  const high = (text: string, i: number): boolean => (text.charCodeAt(i) & 0xfc00) === 0xd800
  return edits.every(
    ({ at, remove, insert }) => !low(from, at) && !low(from, at + remove) && !low(insert, 0) && !high(insert, insert.length - 1),
  )
}

/** In ascending order and separated by unchanged text. */
function apart(edits: readonly TextEdit[]): boolean {
  return edits.every((edit, j) => j === 0 || edit.at > edits[j - 1]!.at + edits[j - 1]!.remove)
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
      const edits = diffText(from, to, AMPLE_MS)
      // Ascending and separated by unchanged text.
      for (let j = 1; j < edits.length; j++) expect(edits[j]!.at).toBeGreaterThan(edits[j - 1]!.at + edits[j - 1]!.remove)
      const coarse = diffText(from, to, -1)
      for (let j = 1; j < coarse.length; j++) expect(coarse[j]!.at).toBeGreaterThanOrEqual(coarse[j - 1]!.at + coarse[j - 1]!.remove)
    }
  })

  it('30,000 random pairs: the target, no split surrogate pair, and as short as the code-point edit distance', () => {
    const random = rng(807)
    const alphabet = ['a', 'b', 'c', ' ', '\n', '😀', '😁', 'é']
    const pick = (n: number): string[] => Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]!)
    /** Deletions plus insertions turning `a` into `b`: n + m - 2 * LCS. */
    const distance = (a: readonly string[], b: readonly string[]): number => {
      let row = new Int32Array(b.length + 1)
      for (const x of a) {
        const next = new Int32Array(b.length + 1)
        for (let j = 0; j < b.length; j++) next[j + 1] = x === b[j] ? row[j]! + 1 : Math.max(row[j + 1]!, next[j]!)
        row = next
      }
      return a.length + b.length - 2 * row[b.length]!
    }
    const failures: unknown[] = []
    for (let i = 0; i < 30_000; i++) {
      const a = pick(Math.floor(random() * 60))
      let b = [...a]
      if (random() < 0.25) b = pick(Math.floor(random() * 60))
      else {
        for (let e = 0; e < 1 + Math.floor(random() * 4); e++) {
          const at = Math.floor(random() * (b.length + 1))
          b.splice(at, Math.floor(random() * 4), ...pick(Math.floor(random() * 4)))
        }
      }
      const [from, to] = [a.join(''), b.join('')]
      const edits = diffText(from, to, AMPLE_MS)
      const length = edits.reduce((sum, { at, remove, insert }) => sum + Array.from(from.slice(at, at + remove)).length + Array.from(insert).length, 0)
      if (applied(from, edits) !== to || !keepsPairs(from, edits) || !apart(edits) || length !== distance(a, b)) {
        failures.push({ from, to, edits })
      }
    }
    expect(failures).toEqual([])
  })

  it('turns large texts into one another through the line pass, within the time limit or past it', () => {
    const random = rng(833)
    const words = ['vault', 'note', 'é', '😀', 'graph', 'a', 'index', '', 'yjs']
    const line = (): string => `${Array.from({ length: Math.floor(random() * 12) }, () => words[Math.floor(random() * words.length)]).join(' ')}\n`
    const failures: unknown[] = []
    for (let i = 0; i < 150; i++) {
      const a = Array.from({ length: 150 + Math.floor(random() * 150) }, line)
      const b = [...a]
      const unrelated = random() < 0.2
      for (let e = 0; e < 1 + Math.floor(random() * 40); e++) {
        const at = Math.floor(random() * b.length)
        const kind = random()
        // A word changed in place, lines inserted or removed, a line replaced, or a `- ` before it.
        if (kind < 0.3) b[at] = b[at]!.replace(/\S+/, words[Math.floor(random() * words.length)]!)
        else if (kind < 0.5) b.splice(at, 0, ...Array.from({ length: 1 + Math.floor(random() * 3) }, line))
        else if (kind < 0.65) b.splice(at, 1 + Math.floor(random() * 3))
        else if (kind < 0.85) b[at] = line()
        else b[at] = `- ${b[at]}`
      }
      const from = a.join('')
      // Sometimes without the last newline, so the last line pairs with one that has it.
      const to = unrelated ? Array.from({ length: a.length }, line).join('') : b.join('').slice(0, random() < 0.2 ? -1 : undefined)
      for (const timeLimitMs of [undefined, -1]) {
        const edits = diffText(from, to, timeLimitMs)
        if (applied(from, edits) !== to || !keepsPairs(from, edits) || !apart(edits)) failures.push({ i, timeLimitMs })
      }
    }
    expect(failures).toEqual([])
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

  /** Applies `next` on the server while a tab, offline, types `typed` at each of `ats`; returns both bodies after they sync. */
  const concurrent = (body: string, next: string, ats: readonly number[], typed: string, timeLimitMs?: number): [string, string] => {
    const server = new Y.Doc()
    server.getText('body').insert(0, body)
    const tab = new Y.Doc()
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(server))
    for (const at of [...ats].sort((x, y) => y - x)) tab.getText('body').insert(at, typed)
    server.transact(() => applyTextDiff(server.getText('body'), next, timeLimitMs))
    Y.applyUpdate(server, Y.encodeStateAsUpdate(tab))
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(server))
    return [server.getText('body').toString(), tab.getText('body').toString()]
  }

  /**
   * Types `TYPED ` after each marker of `body` while the server writes `next`,
   * and expects it after the same marker in `next` on both docs: each marker
   * occurs once in each text, inside a line the write keeps but may change.
   */
  const expectTypingKept = (body: string, next: string, markers: readonly string[], timeLimitMs?: number): void => {
    const [server, tab] = concurrent(
      body,
      next,
      markers.map((marker) => body.indexOf(marker) + marker.length),
      'TYPED ',
      timeLimitMs,
    )
    let expected = next
    for (const marker of markers) expected = expected.replace(marker, `${marker}TYPED `)
    expect(server).toBe(expected)
    expect(tab).toBe(expected)
  }

  /** A paragraph line of `n` random words after a unique `Paragraph <k> holds ` marker. */
  const paragraphs = (seed: number) => {
    const random = rng(seed)
    const words = ['vault', 'note', 'graph', 'index', 'agent', 'search', 'yjs', 'crash']
    return (k: number | string, n: number): string =>
      `Paragraph ${k} holds ${Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(' ')}.\n`
  }

  const removedUnits = (from: string, to: string, timeLimitMs?: number): number => diffText(from, to, timeLimitMs).reduce((sum, edit) => sum + edit.remove, 0)

  // Review round 2 of #833: a new paragraph between two edited ones could
  // line up with only one of them, and the other was replaced.
  for (const timeLimitMs of [AMPLE_MS, -1]) {
    it(`keeps typing in both edited paragraphs a large new one is added between (${limitName(timeLimitMs)})`, () => {
      const paragraph = paragraphs(4)
      const before = Array.from({ length: 30 }, (_, k) => `${paragraph(k, 30)}\n`)
      const after = Array.from({ length: 30 }, (_, k) => `\n${paragraph(k + 100, 30)}`)
      const [a, b] = [paragraph('A', 30), paragraph('B', 30)]
      const added = paragraph('NEW', 80)
      expect(added.length).toBeGreaterThan(400)
      const body = [...before, a, '\n', b, ...after].join('')
      // Each edited at its end; the person types near the start of each.
      const editedA = a.replace(/ (\w+)\.\n$/, ' changed.\n')
      const editedB = b.replace(/ (\w+)\.\n$/, ' edited.\n')
      const next = [...before, editedA, '\n', added, '\n', editedB, ...after].join('')
      expectTypingKept(body, next, ['Paragraph A holds ', 'Paragraph B holds '], timeLimitMs)
      expect(removedUnits(body, next, timeLimitMs)).toBeLessThan(20)
    })
  }

  // Review round 2 of #833: a long sentence added inside a paragraph that also
  // had a word changed counted as unlike, so the line was replaced from the
  // changed word to its end.
  for (const where of ['appended', 'prepended'] as const) {
    it(`keeps typing in a paragraph with a long sentence ${where} and a word changed`, () => {
      const paragraph = paragraphs(5)
      const line = paragraph('P', 40)
      const sentence = paragraph('S', 80).slice(0, -1)
      expect(sentence.length).toBeGreaterThan(400)
      const words = line.slice(0, -2).split(' ')
      // A word changed on the side away from the sentence; the person types in the middle.
      const marker = `${words.slice(15, 18).join(' ')} `
      expect(line.indexOf(marker)).toBe(line.lastIndexOf(marker))
      const changed =
        where === 'appended'
          ? line.replace('Paragraph P holds ', 'Paragraph P now holds ').replace(/\.\n$/, `. ${sentence}\n`)
          : `${sentence} ${line.replace(/ (\w+)\.\n$/, ' changed.\n')}`
      const notes = Array.from({ length: 20 }, (_, k) => `${paragraph(k, 30)}\n`)
      const body = [...notes, line, ...notes].join('')
      const next = [...notes, changed, ...notes].join('')
      expectTypingKept(body, next, [marker], AMPLE_MS)
      expect(removedUnits(body, next, AMPLE_MS)).toBeLessThan(20)
    })
  }

  // Review rounds 2 and 3 of #833: every paragraph changed and one added or
  // removed in the middle: nothing anchors the line diff, and one shift
  // across the whole note (round 2), or an alignment scored only by common
  // starts and ends when every paragraph changes at both ends (round 3),
  // lined up only one half, so the other half was replaced.
  const shapes = {
    'a `- ` before each': (line: string): string => `- ${line}`,
    'each wrapped in `**`': (line: string): string => `**${line.slice(0, -1)}**\n`,
    'a `- ` before each and its period dropped': (line: string): string => `- ${line.slice(0, -2)}\n`,
  }
  for (const [shape, change] of Object.entries(shapes)) {
    // Changed at both ends, past the time limit the pairs keep nothing to trim to, as on dev.
    const limits = shape === 'a `- ` before each' ? [AMPLE_MS, -1] : [AMPLE_MS]
    for (const size of [9_000, 24_000, 50_000]) {
      for (const edit of ['added', 'removed'] as const) {
        for (const timeLimitMs of limits) {
          it(`keeps typing when every paragraph of a ${size / 1000} KB note changes (${shape}) and one is ${edit} in the middle (${limitName(timeLimitMs)})`, () => {
            const paragraph = paragraphs(size + (edit === 'added' ? 1 : 2))
            const lines: string[] = []
            while (lines.join('').length < size) lines.push(paragraph(lines.length, 30))
            const n = lines.length
            const middle = Math.floor(n / 2)
            const body = lines.map((line) => `${line}\n`).join('')
            const changed = lines.map((line) => `${change(line)}\n`)
            if (edit === 'added') changed.splice(middle, 0, `${change(paragraph('NEW', 30))}\n`)
            else changed.splice(middle, 1)
            const next = changed.join('')
            // Typing in every fifth paragraph, and either side of the middle.
            const typed = new Set([middle - 2, middle + 2])
            for (let k = 1; k < n; k += 5) if (k !== middle) typed.add(k)
            expectTypingKept(body, next, [...typed].map((k) => `Paragraph ${k} holds `), timeLimitMs)
            // Only what the shape removes from each kept paragraph (a period), and the removed paragraph.
            const perLine = shape.includes('period') ? 1 : 0
            expect(removedUnits(body, next, timeLimitMs)).toBeLessThanOrEqual(perLine * n + (edit === 'added' ? 0 : lines[middle]!.length + 1))
          })
        }
      }
    }
  }

  // Review of #833: a large new paragraph added before an existing one (with
  // a word changed in it) paired the existing paragraph with the new one and
  // replaced it, so typing in it moved to the end of the new paragraph.
  for (const far of [false, true]) {
    for (const timeLimitMs of [AMPLE_MS, -1]) {
      it(`keeps typing in a paragraph a large new one is added before (${far ? 'with a far change too' : 'one change'}, ${limitName(timeLimitMs)})`, () => {
        const random = rng(far ? 2 : 1)
        const words = ['vault', 'note', 'graph', 'index', 'agent', 'search', 'yjs', 'crash']
        const paragraph = (n: number): string => `${Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(' ')}.\n`
        const before = Array.from({ length: 40 }, () => paragraph(30))
        const existing = `The existing paragraph holds the words a person is typing into right now, ${paragraph(25)}`
        // 80 paragraphs after it: with the far change, the changed region is over 16 K units, so the line pass handles it.
        const after = Array.from({ length: 80 }, () => paragraph(30))
        const body = [...before, '\n', existing, '\n', ...after].join('')
        const added = paragraph(80)
        expect(added.length).toBeGreaterThan(400)
        const tail = far ? after.map((line, i) => (i === after.length - 1 ? `${line.slice(0, -1)} Appended far away.\n` : line)) : after
        const next = [...before, '\n', added, '\n', existing.replace('holds the words', 'holds all the words'), '\n', ...tail].join('')
        const at = body.indexOf('a person is') + 'a person '.length
        const [server, tab] = concurrent(body, next, [at], 'TYPED ', timeLimitMs)
        const expected = next.replace('a person is', 'a person TYPED is')
        expect(server).toBe(expected)
        expect(tab).toBe(expected)
        expect(diffText(body, next, timeLimitMs).reduce((sum, edit) => sum + edit.remove, 0)).toBeLessThan(10)
      })
    }
  }

  it('changes only the characters that differ in a 100 K-character line with 1,200 scattered changes', () => {
    const random = rng(6)
    const words = ['vault', 'note', 'graph', 'index', 'agent', 'search', 'yjs', 'crash']
    const line = `${Array.from({ length: 18_000 }, () => words[Math.floor(random() * words.length)]).join(' ')}.\n`
    expect(line.length).toBeGreaterThan(100_000)
    const characters = [...line]
    for (let i = 0; i < 1_200; i++) characters[50 + i * 80] = '#'
    const next = characters.join('')
    const edits = diffText(line, next, AMPLE_MS)
    expect(applied(line, edits)).toBe(next)
    expect(edits.reduce((sum, edit) => sum + edit.remove, 0)).toBeLessThanOrEqual(1_200)
  })

  it('keeps typing in the middle of a long paragraph changed only at both ends', () => {
    const random = rng(3)
    const words = ['vault', 'note', 'graph', 'index', 'agent', 'search', 'yjs', 'crash']
    const long = `${Array.from({ length: 480 }, () => words[Math.floor(random() * words.length)]).join(' ')}.\n`
    expect(long.length).toBeGreaterThan(2_500)
    const body = `# Title\n\n${long}\nEnd.\n`
    const changed = `X${long.slice(1, -2)}!\n`
    const next = body.replace(long, changed)
    expect(diffText(body, next, AMPLE_MS)).toEqual([
      { at: '# Title\n\n'.length, remove: 1, insert: 'X' },
      { at: '# Title\n\n'.length + long.length - 2, remove: 1, insert: '!' },
    ])
    const middle = '# Title\n\n'.length + Math.floor(long.length / 2)
    const at = body.indexOf(' ', middle) + 1
    const [server, tab] = concurrent(body, next, [at], 'TYPED ', AMPLE_MS)
    const expected = next.slice(0, at) + 'TYPED ' + next.slice(at)
    expect(server).toBe(expected)
    expect(tab).toBe(expected)
  })
})
