/**
 * The line contract (ADR-004 §2.2, #418): one definition of "line" for
 * search, reads, extraction and the note store. Lines are 1-based and
 * inclusive and split on `\n` only: a `\r` stays part of its line, so a
 * CRLF text keeps its bytes. The `\n` that ends a line is not part of it,
 * and a text ending in `\n` has no empty line after it (what an editor and
 * GitHub show). Derived text (snippets, block text, embedded text) is always
 * a substring of the stored text: nothing here collapses or trims.
 */

/** Lines in `text`: 0 for '', else the `\n` count plus one unless `text` ends with `\n`. */
export function totalLines(text: string): number {
  if (text === '') return 0
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n + (text.endsWith('\n') ? 0 : 1)
}

/** The offset of each line's first character: `starts[k]` is where line k + 1 begins (`totalLines(text)` entries). */
export function lineStarts(text: string): number[] {
  if (text === '') return []
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1 && i + 1 < text.length; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/**
 * Lines `start`..`end` of `text` (1-based, inclusive) as one substring: from
 * the first character of `start` to the last of `end`, without the `\n`
 * that ends `end`. `end` past the last line stops there; an empty range is
 * ''. Pass `starts` (`lineStarts(text)`) when slicing one text many times.
 */
export function sliceLines(text: string, start: number, end: number, starts: number[] = lineStarts(text)): string {
  const last = Math.min(end, starts.length)
  if (start < 1 || start > last) return ''
  const to = last < starts.length ? starts[last]! - 1 : text.endsWith('\n') ? text.length - 1 : text.length
  return text.slice(starts[start - 1]!, to)
}

/** A citable location: `path#L<start>-L<end>`, or `path#L<start>` for one line (GitHub's form, okf-format §5.2). */
export function location(path: string, start: number, end: number): string {
  return start === end ? `${path}#L${start}` : `${path}#L${start}-L${end}`
}
