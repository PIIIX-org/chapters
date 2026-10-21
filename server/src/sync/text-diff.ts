import type * as Y from 'yjs'

/**
 * Minimal text changes for a write to a live document (#408). A server-side
 * edit used to delete the whole Y.Text and insert the new body, so every
 * character a person had typed became a tombstone: typing that reached the
 * relay just after it was anchored to deleted text and landed at the start
 * of the note, and the caret jumped to the top. Applying only the characters
 * that differ keeps every untouched character's identity, so concurrent
 * typing outside the changed region merges where it was typed (ADR-003 §5.2
 * step 5: a time-bounded character diff, never delete-all/insert-all).
 *
 * The diff is per character (code point) first, with Myers' O(ND) algorithm
 * and its linear-space middle snake, bounded by a time limit. Past the limit
 * it is redone per line, and per character inside each changed run of lines
 * as far as a second limit allows; a run left over pairs its old and new
 * lines in order and changes each pair between their common start and end,
 * so a rewrite of every line (a `- ` before each) still keeps each line's
 * unchanged characters. A 1 MiB rewrite costs at most the two limits plus
 * linear work. Characters are compared by code point, so no change splits a
 * surrogate pair (Yjs would turn a split pair into U+FFFD).
 */

/** One change, in UTF-16 offsets of the old text: remove `remove` units at `at`, then insert `insert` there. */
export interface TextEdit {
  at: number
  remove: number
  insert: string
}

/** How long a diff may search for a minimal script before it settles for a coarser one. */
export const DIFF_TIME_LIMIT_MS = 100

const EQUAL = 0
const DELETE = 1
const INSERT = 2

/** `n` tokens kept, deleted from the old sequence, or inserted from the new one. */
interface Run {
  op: typeof EQUAL | typeof DELETE | typeof INSERT
  n: number
}

type Tokens = ArrayLike<number>

/**
 * The furthest-reaching middle snake of a[a0..a1) → b[b0..b1): a point on an
 * optimal edit path that splits it into two parts of about half the edits
 * each, or null past the deadline. Both ranges are non-empty and share no
 * prefix or suffix, so the path has at least two edits and both parts are
 * strictly smaller than the whole.
 */
function middleSnake(a: Tokens, a0: number, a1: number, b: Tokens, b0: number, b1: number, deadline: number): [number, number] | null {
  const n = a1 - a0
  const m = b1 - b0
  const max = Math.ceil((n + m) / 2)
  const offset = max + 1
  const size = 2 * max + 3
  // Furthest x reached on each diagonal k = x - y, forward from the start and backward from the end.
  const forward = new Int32Array(size).fill(-1)
  const backward = new Int32Array(size).fill(-1)
  forward[offset + 1] = 0
  backward[offset + 1] = 0
  const delta = n - m
  // With an odd delta the paths meet on a forward step, otherwise on a backward one.
  const odd = (delta & 1) !== 0
  // Diagonals that left the grid are not extended again.
  let forwardLow = 0
  let forwardHigh = 0
  let backwardLow = 0
  let backwardHigh = 0
  for (let d = 0; d <= max; d++) {
    if (Date.now() > deadline) return null
    for (let k = -d + forwardLow; k <= d - forwardHigh; k += 2) {
      const i = offset + k
      let x = k === -d || (k !== d && forward[i - 1]! < forward[i + 1]!) ? forward[i + 1]! : forward[i - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++
        y++
      }
      forward[i] = x
      if (x > n) forwardHigh += 2
      else if (y > m) forwardLow += 2
      else if (odd) {
        const j = offset + delta - k
        if (j >= 0 && j < size && backward[j] !== -1 && x >= n - backward[j]!) return [a0 + x, b0 + y]
      }
    }
    for (let k = -d + backwardLow; k <= d - backwardHigh; k += 2) {
      const i = offset + k
      let x = k === -d || (k !== d && backward[i - 1]! < backward[i + 1]!) ? backward[i + 1]! : backward[i - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[a1 - 1 - x] === b[b1 - 1 - y]) {
        x++
        y++
      }
      backward[i] = x
      if (x > n) backwardHigh += 2
      else if (y > m) backwardLow += 2
      else if (!odd) {
        const kf = delta - k
        const j = offset + kf
        if (j >= 0 && j < size && forward[j] !== -1) {
          const fx = forward[j]!
          if (fx >= n - x) return [a0 + fx, b0 + fx - kf]
        }
      }
    }
  }
  return null
}

/** The edit script a → b as runs; past the deadline a part is a delete plus an insert, and `complete` is false. */
function diffTokens(a: Tokens, b: Tokens, deadline: number): { runs: Run[]; complete: boolean } {
  let complete = true
  const runs: Run[] = []
  const push = (op: Run['op'], n: number): void => {
    if (n === 0) return
    const last = runs.at(-1)
    if (last?.op === op) last.n += n
    else runs.push({ op, n })
  }
  const solve = (a0: number, a1: number, b0: number, b1: number): void => {
    let prefix = 0
    while (a0 + prefix < a1 && b0 + prefix < b1 && a[a0 + prefix] === b[b0 + prefix]) prefix++
    let suffix = 0
    while (a1 - suffix > a0 + prefix && b1 - suffix > b0 + prefix && a[a1 - suffix - 1] === b[b1 - suffix - 1]) suffix++
    push(EQUAL, prefix)
    const [x0, x1, y0, y1] = [a0 + prefix, a1 - suffix, b0 + prefix, b1 - suffix]
    if (x0 === x1 || y0 === y1) {
      push(DELETE, x1 - x0)
      push(INSERT, y1 - y0)
    } else {
      const split = middleSnake(a, x0, x1, b, y0, y1, deadline)
      if (split) {
        solve(x0, split[0], y0, split[1])
        solve(split[0], x1, split[1], y1)
      } else {
        complete = false
        push(DELETE, x1 - x0)
        push(INSERT, y1 - y0)
      }
    }
    push(EQUAL, suffix)
  }
  solve(0, a.length, 0, b.length)
  return { runs, complete }
}

/** `text` split after each `\n`. */
function lines(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
    out.push(text.slice(start, nl + 1))
    start = nl + 1
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

/** Each line as a number, equal lines (in either list) as the same number, for diffTokens. */
function lineTokens(aLines: readonly string[], bLines: readonly string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>()
  const tokenize = (parts: readonly string[]): Int32Array =>
    Int32Array.from(parts, (line) => {
      let id = ids.get(line)
      if (id === undefined) ids.set(line, (id = ids.size))
      return id
    })
  return [tokenize(aLines), tokenize(bLines)]
}

/**
 * Character changes turning `from` into `to`, the slices at UTF-16 offset
 * `at` of the old text, added to `out`. False when the deadline cut the
 * search short (the changes are still correct, only coarser).
 */
function characterEdits(from: string, to: string, at: number, deadline: number, out: TextEdit[]): boolean {
  if (from === '' || to === '') {
    out.push({ at, remove: from.length, insert: to })
    return true
  }
  const a = Array.from(from, (c) => c.codePointAt(0)!)
  const b = Array.from(to, (c) => c.codePointAt(0)!)
  const units = (codes: number[], start: number, n: number): number => {
    let length = 0
    for (let i = start; i < start + n; i++) length += codes[i]! > 0xffff ? 2 : 1
    return length
  }
  let ai = 0
  let bi = 0
  let aOffset = 0
  let bOffset = 0
  let pending: TextEdit | null = null
  const { runs, complete } = diffTokens(a, b, deadline)
  for (const run of runs) {
    if (run.op === EQUAL) {
      if (pending) out.push(pending)
      pending = null
      aOffset += units(a, ai, run.n)
      bOffset += units(b, bi, run.n)
      ai += run.n
      bi += run.n
      continue
    }
    pending ??= { at: at + aOffset, remove: 0, insert: '' }
    if (run.op === DELETE) {
      const length = units(a, ai, run.n)
      pending.remove += length
      aOffset += length
      ai += run.n
    } else {
      const length = units(b, bi, run.n)
      pending.insert += to.slice(bOffset, bOffset + length)
      bOffset += length
      bi += run.n
    }
  }
  if (pending) out.push(pending)
  return complete
}

/**
 * The one change turning `from` into `to` between their longest common start
 * and end, at UTF-16 offset `at`, or null when they are equal. The kept start
 * and end never split a surrogate pair.
 */
function trimmedEdit(from: string, to: string, at: number): TextEdit | null {
  if (from === to) return null
  const shorter = Math.min(from.length, to.length)
  let start = 0
  while (start < shorter && from.charCodeAt(start) === to.charCodeAt(start)) start++
  // The kept start must not end on the first half of a pair (U+D800-U+DBFF).
  if (start > 0 && (from.charCodeAt(start - 1) & 0xfc00) === 0xd800) start--
  let end = 0
  while (end < shorter - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++
  // The kept end must not begin on the second half of a pair (U+DC00-U+DFFF).
  if (end > 0 && (from.charCodeAt(from.length - end) & 0xfc00) === 0xdc00) end--
  return { at: at + start, remove: from.length - start - end, insert: to.slice(start, to.length - end) }
}

/**
 * A changed run of lines the character diff could not settle in time: the
 * old and new lines paired in order, each pair changed between its common
 * start and end, then the lines one side has left over. Linear, and it keeps
 * the identity of every character a pair shares at its start and end.
 */
function pairedLineEdits(from: readonly string[], to: readonly string[], at: number, out: TextEdit[]): void {
  const pairs = Math.min(from.length, to.length)
  let offset = at
  for (let i = 0; i < pairs; i++) {
    const edit = trimmedEdit(from[i]!, to[i]!, offset)
    if (edit) out.push(edit)
    offset += from[i]!.length
  }
  let remove = 0
  for (let i = pairs; i < from.length; i++) remove += from[i]!.length
  const insert = to.slice(pairs).join('')
  if (remove > 0 || insert !== '') out.push({ at: offset, remove, insert })
}

/** The changes that turn `from` into `to`, in ascending order of `at`; empty when they are equal. */
export function diffText(from: string, to: string, timeLimitMs = DIFF_TIME_LIMIT_MS): TextEdit[] {
  if (from === to) return []
  const characters: TextEdit[] = []
  if (characterEdits(from, to, 0, Date.now() + timeLimitMs, characters)) return characters
  // Too many changes to settle per character in time: per line, then per character inside each changed run.
  const deadline = Date.now() + timeLimitMs
  const aLines = lines(from)
  const bLines = lines(to)
  const edits: TextEdit[] = []
  let ai = 0
  let bi = 0
  let aOffset = 0
  // A changed run of lines: its old and new lines, diffed per character once the run ends.
  let removed: string[] = []
  let inserted: string[] = []
  let runStart = 0
  const refined: TextEdit[] = []
  const flush = (): void => {
    if (removed.length === 0 && inserted.length === 0) return
    refined.length = 0
    if (Date.now() <= deadline && characterEdits(removed.join(''), inserted.join(''), runStart, deadline, refined)) {
      for (const edit of refined) edits.push(edit)
    } else {
      pairedLineEdits(removed, inserted, runStart, edits)
    }
    removed = []
    inserted = []
  }
  for (const run of diffTokens(...lineTokens(aLines, bLines), deadline).runs) {
    if (run.op === EQUAL) {
      flush()
      for (let i = 0; i < run.n; i++) aOffset += aLines[ai + i]!.length
      ai += run.n
      bi += run.n
      continue
    }
    if (removed.length === 0 && inserted.length === 0) runStart = aOffset
    if (run.op === DELETE) {
      for (let i = 0; i < run.n; i++) {
        removed.push(aLines[ai + i]!)
        aOffset += aLines[ai + i]!.length
      }
      ai += run.n
    } else {
      for (let i = 0; i < run.n; i++) inserted.push(bLines[bi + i]!)
      bi += run.n
    }
  }
  flush()
  return edits
}

/** A changed run of lines (#475): the old text's lines `start` to `end` (exclusive) replaced by `lines`. */
export interface LineHunk {
  start: number
  end: number
  lines: string[]
}

/** The lines of a text (split after each `\n`) and the runs of them a diff changes. */
export interface LineDiff {
  lines: string[]
  hunks: LineHunk[]
}

/**
 * The changes that turn `from` into `to`, per whole line: `from`'s lines and
 * the hunks, in ascending order, never touching one another (an unchanged
 * line separates any two). Past the time limit a part is one coarser hunk,
 * still correct.
 */
export function diffLines(from: string, to: string, timeLimitMs = DIFF_TIME_LIMIT_MS): LineDiff {
  const aLines = lines(from)
  const bLines = lines(to)
  const hunks: LineHunk[] = []
  let ai = 0
  let bi = 0
  let open: LineHunk | null = null
  for (const run of diffTokens(...lineTokens(aLines, bLines), Date.now() + timeLimitMs).runs) {
    if (run.op === EQUAL) {
      open = null
      ai += run.n
      bi += run.n
      continue
    }
    if (!open) hunks.push((open = { start: ai, end: ai, lines: [] }))
    if (run.op === DELETE) {
      ai += run.n
      open.end = ai
    } else {
      for (let i = 0; i < run.n; i++) open.lines.push(bLines[bi + i]!)
      bi += run.n
    }
  }
  return { lines: aLines, hunks }
}

/**
 * Turns the live `text` into `next` with the fewest character changes. Call
 * it inside the document transaction that should carry the edit.
 *
 * In each change the new text goes in before the old is deleted (#483): a
 * caret at the end of a replaced span lands after the new text, and typing
 * still in flight from an editor (anchored to a deleted character) joins
 * after it rather than racing the new text for the spot.
 */
export function applyTextDiff(text: Y.Text, next: string, timeLimitMs = DIFF_TIME_LIMIT_MS): void {
  const edits = diffText(text.toString(), next, timeLimitMs)
  // Last change first: each one's offsets refer to the text before any change.
  for (let i = edits.length - 1; i >= 0; i--) {
    const { at, remove, insert } = edits[i]!
    if (insert !== '') text.insert(at, insert)
    if (remove > 0) text.delete(at + insert.length, remove)
  }
}
