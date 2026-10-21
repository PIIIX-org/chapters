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
 * The common start and end of the two texts are set aside first (a linear
 * scan, no copy of the body), so an append or a change in one place costs
 * about as much as reading the text once (#833). What is left is diffed per
 * character (code point) with Myers' O(ND) algorithm and its linear-space
 * middle snake: exactly when it is small, so a small edit is as short as the
 * code-point edit distance, and when it is larger only as long as the two
 * sides are alike (an edit distance under a share of their length), since a
 * character diff of unrelated text costs quadratic time and cuts the note
 * into thousands of fragments. Otherwise the whole lines around it are
 * diffed per line (lines found on one side only can never match, so they
 * skip the search). A changed run with as many new lines as old ones pairs
 * them in order; any other run is diffed per character under the same rule,
 * and if it is too large or too unlike its lines are paired in order too.
 * Each pair is diffed per character if alike, otherwise changed between its
 * common start and end, so a rewrite of every line (a `- ` before each)
 * still keeps each line's unchanged characters. One time limit bounds the
 * whole diff (ADR-003 §5.2 step 5); past it the rest is linear work
 * (pairs trimmed to their common start and end). Characters are
 * compared by code point, so no change splits a surrogate pair (Yjs would
 * turn a split pair into U+FFFD).
 */

/** One change, in UTF-16 offsets of the old text: remove `remove` units at `at`, then insert `insert` there. */
export interface TextEdit {
  at: number
  remove: number
  insert: string
}

/** How long a diff may search for a minimal script before it settles for a coarser one. */
export const DIFF_TIME_LIMIT_MS = 100

/** A change to a text no larger than this many UTF-16 units (both sides) is diffed per character exactly (#833). */
const EXACT_UNITS = 256
/** Larger changes are diffed per character, if alike enough, up to this many units; past it per line first. */
const CHARACTER_UNITS = 4_096
/** Alike enough for a character diff: an edit distance at most this share of both sides' length. */
const ALIKE_SHARE = 0.25

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
 * each, or null past the deadline or when the path needs more than `limit`
 * edits. Both ranges are non-empty and share no prefix or suffix, so the
 * path has at least two edits and both parts are strictly smaller than the
 * whole.
 */
function middleSnake(a: Tokens, a0: number, a1: number, b: Tokens, b0: number, b1: number, deadline: number, limit: number): [number, number] | null {
  const n = a1 - a0
  const m = b1 - b0
  const max = Math.ceil((n + m) / 2)
  // Each side reaches the meeting point within half the edits.
  const last = Math.min(max, Math.ceil(limit / 2))
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
  for (let d = 0; d <= last; d++) {
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

/** Adds `n` tokens of `op` to `runs`, joined to the last run when it has the same op. */
function pushRun(runs: Run[], op: Run['op'], n: number): void {
  if (n === 0) return
  const last = runs.at(-1)
  if (last?.op === op) last.n += n
  else runs.push({ op, n })
}

/**
 * The edit script a → b as runs. Past the deadline, or when the whole script
 * needs more than `limit` edits, a part is a delete plus an insert and
 * `complete` is false.
 */
function diffTokens(a: Tokens, b: Tokens, deadline: number, limit = Infinity): { runs: Run[]; complete: boolean } {
  let complete = true
  const runs: Run[] = []
  const push = (op: Run['op'], n: number): void => pushRun(runs, op, n)
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
      const split = middleSnake(a, x0, x1, b, y0, y1, deadline, limit)
      // The first split holds the whole script; the parts of an optimal one need no limit.
      limit = Infinity
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
 * The line runs turning `aLines` into `bLines`. A line found on one side only
 * can never be kept, so the search runs over the other lines alone and those
 * are deleted or inserted where they stand: a rewrite of every line costs
 * linear time rather than the search's quadratic worst case (#833).
 */
function lineRuns(aLines: readonly string[], bLines: readonly string[], deadline: number): Run[] {
  const [a, b] = lineTokens(aLines, bLines)
  let ids = 0
  for (const id of a) ids = Math.max(ids, id + 1)
  for (const id of b) ids = Math.max(ids, id + 1)
  const inA = new Uint8Array(ids)
  const inB = new Uint8Array(ids)
  for (const id of a) inA[id] = 1
  for (const id of b) inB[id] = 1
  const keptA: number[] = []
  const keptB: number[] = []
  for (let i = 0; i < a.length; i++) if (inB[a[i]!]) keptA.push(i)
  for (let j = 0; j < b.length; j++) if (inA[b[j]!]) keptB.push(j)
  const kept = diffTokens(
    keptA.map((i) => a[i]!),
    keptB.map((j) => b[j]!),
    deadline,
  ).runs
  const runs: Run[] = []
  let ai = 0
  let bi = 0
  let ka = 0
  let kb = 0
  for (const run of kept) {
    if (run.op === DELETE) ka += run.n
    else if (run.op === INSERT) kb += run.n
    else {
      for (let t = 0; t < run.n; t++, ka++, kb++) {
        const i = keptA[ka]!
        const j = keptB[kb]!
        pushRun(runs, DELETE, i - ai)
        pushRun(runs, INSERT, j - bi)
        pushRun(runs, EQUAL, 1)
        ai = i + 1
        bi = j + 1
      }
    }
  }
  pushRun(runs, DELETE, a.length - ai)
  pushRun(runs, INSERT, b.length - bi)
  return runs
}

/**
 * The longest common start and end of `a` and `b` in UTF-16 units, not
 * overlapping, and never splitting a surrogate pair.
 */
function commonEnds(a: string, b: string): [number, number] {
  const shorter = Math.min(a.length, b.length)
  let start = 0
  while (start < shorter && a.charCodeAt(start) === b.charCodeAt(start)) start++
  // The kept start must not end on the first half of a pair (U+D800-U+DBFF).
  if (start > 0 && (a.charCodeAt(start - 1) & 0xfc00) === 0xd800) start--
  let end = 0
  while (end < shorter - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++
  // The kept end must not begin on the second half of a pair (U+DC00-U+DFFF).
  if (end > 0 && (a.charCodeAt(a.length - end) & 0xfc00) === 0xdc00) end--
  return [start, end]
}

/** The code points of text[start..end). */
function codePoints(text: string, start: number, end: number): number[] {
  const out: number[] = []
  for (let i = start; i < end; ) {
    const code = text.codePointAt(i)!
    out.push(code)
    i += code > 0xffff ? 2 : 1
  }
  return out
}

/**
 * Character changes turning `from` into `to`, the slices at UTF-16 offset
 * `at` of the old text, added to `out`, where the two share their first
 * `start` and last `end` units (commonEnds). False, adding nothing, when the
 * changed part is too large or too unlike for a character diff (unless
 * `exact` and it is small), or the deadline cut the search short.
 */
function characterEditsWithin(from: string, to: string, start: number, end: number, at: number, deadline: number, exact: boolean, out: TextEdit[]): boolean {
  const removed = from.length - start - end
  const inserted = to.length - start - end
  if (removed === 0 || inserted === 0) {
    if (removed > 0 || inserted > 0) out.push({ at: at + start, remove: removed, insert: to.slice(start, start + inserted) })
    return true
  }
  const size = removed + inserted
  if (size > CHARACTER_UNITS || Date.now() > deadline) return false
  const a = codePoints(from, start, start + removed)
  const b = codePoints(to, start, start + inserted)
  const limit = exact && size <= EXACT_UNITS ? Infinity : Math.floor(size * ALIKE_SHARE)
  const { runs, complete } = diffTokens(a, b, deadline, limit)
  if (!complete) return false
  const units = (codes: number[], first: number, n: number): number => {
    let length = 0
    for (let i = first; i < first + n; i++) length += codes[i]! > 0xffff ? 2 : 1
    return length
  }
  let ai = 0
  let bi = 0
  let aOffset = start
  let bOffset = start
  let pending: TextEdit | null = null
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
  return true
}

/** characterEditsWithin for any two texts, never exact past the alike share. */
function characterEdits(from: string, to: string, at: number, deadline: number, out: TextEdit[]): boolean {
  const [start, end] = commonEnds(from, to)
  return characterEditsWithin(from, to, start, end, at, deadline, false, out)
}

/**
 * The one change turning `from` into `to` between their longest common start
 * and end, at UTF-16 offset `at`, or null when they are equal. The kept start
 * and end never split a surrogate pair.
 */
function trimmedEdit(from: string, to: string, at: number): TextEdit | null {
  if (from === to) return null
  const [start, end] = commonEnds(from, to)
  return { at: at + start, remove: from.length - start - end, insert: to.slice(start, to.length - end) }
}

/**
 * A changed run of lines: the old and new lines paired in order, each pair
 * diffed per character if alike enough, otherwise changed between its common
 * start and end, then the lines one side has left over. It keeps the
 * identity of every character a pair shares at its start and end, and past
 * the deadline it is linear.
 */
function pairedLineEdits(from: readonly string[], to: readonly string[], at: number, deadline: number, out: TextEdit[]): void {
  const pairs = Math.min(from.length, to.length)
  let offset = at
  for (let i = 0; i < pairs; i++) {
    if (!characterEdits(from[i]!, to[i]!, offset, deadline, out)) {
      const edit = trimmedEdit(from[i]!, to[i]!, offset)
      if (edit) out.push(edit)
    }
    offset += from[i]!.length
  }
  let remove = 0
  for (let i = pairs; i < from.length; i++) remove += from[i]!.length
  const insert = to.slice(pairs).join('')
  if (remove === 0 && insert === '') return
  const last = out.at(-1)
  // A last pair changed up to its end (a last line without `\n`) touches the lines left over: one change.
  if (last && last.at + last.remove === offset) {
    last.remove += remove
    last.insert += insert
  } else out.push({ at: offset, remove, insert })
}

/**
 * The changes turning `from` into `to`, whole lines at UTF-16 offset `at` of
 * the old text that already failed per character as a whole, per line first.
 * A changed run with as many new lines as old ones pairs them in order; any
 * other run is diffed per character if small and alike enough, otherwise
 * paired too.
 */
function lineEdits(from: string, to: string, at: number, deadline: number, out: TextEdit[]): void {
  const aLines = lines(from)
  const bLines = lines(to)
  // The changed run so far: lines a0..ai and b0..bi, from UTF-16 offsets aStart..aOffset and bStart..bOffset.
  let ai = 0
  let bi = 0
  let a0 = 0
  let b0 = 0
  let aOffset = 0
  let bOffset = 0
  let aStart = 0
  let bStart = 0
  const flush = (): void => {
    if (ai === a0 && bi === b0) return
    // The whole text as one run fails per character again.
    const whole = a0 === 0 && b0 === 0 && ai === aLines.length && bi === bLines.length
    if (ai - a0 === bi - b0 || whole || !characterEdits(from.slice(aStart, aOffset), to.slice(bStart, bOffset), at + aStart, deadline, out)) {
      pairedLineEdits(aLines.slice(a0, ai), bLines.slice(b0, bi), at + aStart, deadline, out)
    }
  }
  for (const run of lineRuns(aLines, bLines, deadline)) {
    if (run.op === EQUAL) {
      flush()
      for (let i = 0; i < run.n; i++) {
        aOffset += aLines[ai + i]!.length
        bOffset += bLines[bi + i]!.length
      }
      ai += run.n
      bi += run.n
      a0 = ai
      b0 = bi
      aStart = aOffset
      bStart = bOffset
    } else if (run.op === DELETE) {
      for (let i = 0; i < run.n; i++) aOffset += aLines[ai + i]!.length
      ai += run.n
    } else {
      for (let i = 0; i < run.n; i++) bOffset += bLines[bi + i]!.length
      bi += run.n
    }
  }
  flush()
}

/** The changes that turn `from` into `to`, in ascending order of `at`; empty when they are equal. */
export function diffText(from: string, to: string, timeLimitMs = DIFF_TIME_LIMIT_MS): TextEdit[] {
  const edits: TextEdit[] = []
  if (from === to) return edits
  const deadline = Date.now() + timeLimitMs
  const [start, end] = commonEnds(from, to)
  if (characterEditsWithin(from, to, start, end, 0, deadline, true, edits)) return edits
  // Too large or too unlike per character: the whole lines around the change, per line.
  const lineStart = start === 0 ? 0 : from.lastIndexOf('\n', start - 1) + 1
  const newline = from.indexOf('\n', from.length - end)
  const kept = newline === -1 ? 0 : from.length - newline - 1
  lineEdits(from.slice(lineStart, from.length - kept), to.slice(lineStart, to.length - kept), lineStart, deadline, edits)
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
