import { isDeepStrictEqual } from 'node:util'
import { diffLines, diffText, type LineHunk, type TextEdit } from './text-diff.js'

/**
 * Three-way merge of an edit made from an older revision of a note (#475,
 * edit_note `base_rev`). `theirs` is the note now (with a person's typing,
 * other writers' changes), `mine` is the edit's version, both descended from
 * `base`. Each side's changes are the line hunks of its diff from the base;
 * a change of `mine` is applied only where no change of `theirs` touches the
 * same base lines, so text changed since the base is never overwritten.
 *
 * Two changes overlap when their base lines intersect, when an insertion
 * falls strictly inside the other side's changed lines, or when both insert
 * at the same point (their order is unknown). Changes on adjacent lines do
 * not overlap. Overlapping changes that produce the same lines (the edit
 * already holds the change made since its base) merge as one. The unit is a
 * whole line: two changes to one line overlap even when they touch different
 * words, so a merge never interleaves two rewrites of the same sentence.
 *
 * One exception (#408): at the end of the text, when `mine` only added whole
 * lines after the base's last one (an agent appending to the body it read
 * while a person types at the end), its lines go after what `theirs` has
 * there; see appendedAtEnd.
 */

/**
 * A change made since the base: `removed` base lines replaced by the `added`
 * lines that start at `line` (1-based) of `theirs`, the text as it is now.
 */
export interface LineChange {
  line: number
  removed: number
  added: number
}

/**
 * The merged text with the changes `theirs` made that `mine` did not, or,
 * when a change of `mine` overlaps one of `theirs`, null with those changes
 * of `theirs`.
 */
export type TextMerge = { text: string; concurrent: LineChange[] } | { text: null; conflicts: LineChange[] }

interface SideHunk extends LineHunk {
  mine: boolean
}

/** `base` lines `start` to `end` with the hunks of one side (`mine` or not) in that range applied. */
function sideLines(base: readonly string[], hunks: readonly SideHunk[], mine: boolean, start: number, end: number): string[] {
  const out: string[] = []
  let at = start
  for (const hunk of hunks) {
    if (hunk.mine !== mine) continue
    for (let i = at; i < hunk.start; i++) out.push(base[i]!)
    for (const line of hunk.lines) out.push(line)
    at = hunk.end
  }
  for (let i = at; i < end; i++) out.push(base[i]!)
  return out
}

/**
 * `theirs`' last lines followed by the lines `mine` appended, when both
 * changed the end of the text and `mine` only added whole lines after the
 * `base` lines there (ending the last one when it had no newline), else null.
 * A line `theirs` left without a newline (a person typing) gets one before
 * them; appended lines `theirs` already ends with (the same append sent again
 * from the same base) are not added twice. When an appended line that is
 * not blank is already somewhere else in `theirs`' changed lines (an append
 * resent from an older base after someone added after it), adding it again
 * would double it and dropping it may lose a line the author meant twice:
 * null, a conflict.
 */
function appendedAtEnd(base: string, theirs: readonly string[], mine: string): string[] | null {
  if (!mine.startsWith(base)) return null
  let added = mine.slice(base.length)
  if (base !== '' && !base.endsWith('\n')) {
    if (!added.startsWith('\n')) return null
    added = added.slice(1)
  }
  const lines = added.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let held = Math.min(lines.length, theirs.length)
  while (held > 0 && !lines.slice(0, held).every((line, i) => line === theirs[theirs.length - held + i])) held--
  const content = (line: string) => line.replace(/\n$/, '')
  const present = new Set(theirs.map(content))
  if (lines.slice(held).some((line) => content(line).trim() !== '' && present.has(content(line)))) return null
  const out = [...theirs]
  const last = out.at(-1)
  if (held < lines.length && last !== undefined && !last.endsWith('\n')) out[out.length - 1] = `${last}\n`
  return [...out, ...lines.slice(held)]
}

/** `mine` merged onto `theirs`, both made from `base` (see the top of this file). */
export function mergeText(base: string, theirs: string, mine: string): TextMerge {
  const merged = mergeLines(base, theirs, mine, false)
  return merged.conflicts.length > 0 ? { text: null, conflicts: merged.conflicts } : { text: merged.text, concurrent: merged.concurrent }
}

/**
 * `mine` merged onto `theirs` where an overlap keeps `theirs`' text instead
 * of refusing the merge (ADR-003 §5.4 rebase: acked typing, `theirs`, stays
 * in the text; `mine`, a row changed behind the store, stays recoverable
 * from its own revision). Changed lines both sides touched are merged again
 * per character (diffText), so two edits to different words of one line
 * both stay; only characters both changed differently keep `theirs`.
 * `overlaps` lists the line groups where some of `mine` was dropped.
 */
export function mergeTextKeepingTheirs(base: string, theirs: string, mine: string): { text: string; overlaps: LineChange[] } {
  const merged = mergeLines(base, theirs, mine, true)
  return { text: merged.text, overlaps: merged.conflicts }
}

function mergeLines(
  base: string,
  theirs: string,
  mine: string,
  keepTheirs: boolean,
): { text: string; concurrent: LineChange[]; conflicts: LineChange[] } {
  const { lines: baseLines, hunks: theirHunks } = diffLines(base, theirs)
  const hunks: SideHunk[] = [
    ...theirHunks.map((hunk) => ({ ...hunk, mine: false })),
    ...diffLines(base, mine).hunks.map((hunk) => ({ ...hunk, mine: true })),
  ]
  // By start; at one start an insertion first, so it is never "inside" a change that starts there.
  hunks.sort((x, y) => x.start - y.start || x.end - x.start - (y.end - y.start))
  const out: string[] = []
  const concurrent: LineChange[] = []
  const conflicts: LineChange[] = []
  // Base lines copied to `out` so far, and how many lines `theirs` has more than the base before them.
  let copied = 0
  let shift = 0
  for (let i = 0; i < hunks.length; ) {
    const group = [hunks[i++]!]
    const start = group[0]!.start
    let end = group[0]!.end
    while (i < hunks.length) {
      const next = hunks[i]!
      const overlaps = next.start < end || (next.start === end && next.end === next.start && start === end)
      if (!overlaps) break
      group.push(next)
      end = Math.max(end, next.end)
      i++
    }
    for (let k = copied; k < start; k++) out.push(baseLines[k]!)
    const theirLines = sideLines(baseLines, group, false, start, end)
    const change: LineChange = { line: start + shift + 1, removed: end - start, added: theirLines.length }
    let text = theirLines.join('')
    if (group.every((hunk) => !hunk.mine)) {
      concurrent.push(change)
    } else {
      const mineText = sideLines(baseLines, group, true, start, end).join('')
      // Lines only appended at the end go after what was added or typed there (#408), before the per-character fallback.
      const appended =
        group.some((hunk) => !hunk.mine) && mineText !== text && end === baseLines.length
          ? appendedAtEnd(baseLines.slice(start, end).join(''), theirLines, mineText)
          : null
      if (!group.some((hunk) => !hunk.mine) || mineText === text) {
        text = mineText
      } else if (appended) {
        concurrent.push(change)
        text = appended.join('')
      } else if (keepTheirs) {
        // Both sides changed these lines: merged again per character, `theirs` kept where characters overlap.
        const merged = mergeCharacters(baseLines.slice(start, end).join(''), text, mineText)
        if (merged.overlap) conflicts.push(change)
        text = merged.text
      } else {
        conflicts.push(change)
        text = mineText
      }
    }
    out.push(text)
    shift += theirLines.length - (end - start)
    copied = end
  }
  for (let k = copied; k < baseLines.length; k++) out.push(baseLines[k]!)
  return { text: out.join(''), concurrent, conflicts }
}

interface SideEdit extends TextEdit {
  mine: boolean
}

/** `base` from `start` to `end` with the edits of one side in that range applied. */
function sideText(base: string, edits: readonly SideEdit[], mine: boolean, start: number, end: number): string {
  let out = ''
  let at = start
  for (const edit of edits) {
    if (edit.mine !== mine) continue
    out += base.slice(at, edit.at) + edit.insert
    at = edit.at + edit.remove
  }
  return out + base.slice(at, end)
}

/**
 * The same merge per character, for one run of lines both sides changed:
 * each side's changes are its diffText edits from `base`; edits that touch
 * different characters (or are the same edit) all apply; where they overlap
 * (shared characters, an insertion inside the other side's removal, or two
 * different insertions at one point) `theirs` is kept and `overlap` is set.
 */
function mergeCharacters(base: string, theirs: string, mine: string): { text: string; overlap: boolean } {
  const edits: SideEdit[] = [
    ...diffText(base, theirs).map((edit) => ({ ...edit, mine: false })),
    ...diffText(base, mine).map((edit) => ({ ...edit, mine: true })),
  ]
  edits.sort((x, y) => x.at - y.at || x.remove - y.remove)
  let out = ''
  let copied = 0
  let overlap = false
  for (let i = 0; i < edits.length; ) {
    const group = [edits[i++]!]
    const start = group[0]!.at
    let end = start + group[0]!.remove
    while (i < edits.length) {
      const next = edits[i]!
      if (!(next.at < end || (next.at === end && next.remove === 0 && start === end))) break
      group.push(next)
      end = Math.max(end, next.at + next.remove)
      i++
    }
    out += base.slice(copied, start)
    const theirText = sideText(base, group, false, start, end)
    if (group.every((edit) => !edit.mine)) out += theirText
    else {
      const mineText = sideText(base, group, true, start, end)
      const both = group.some((edit) => !edit.mine)
      if (both && mineText !== theirText) overlap = true
      out += both ? theirText : mineText
    }
    copied = end
  }
  return { text: out + base.slice(copied), overlap }
}

/** The merged frontmatter, the keys only `theirs` changed, and the keys both changed differently. */
export interface FrontmatterMerge {
  frontmatter: Record<string, unknown>
  concurrent: string[]
  conflicts: string[]
}

/**
 * The frontmatter merged per top-level key: a key `mine` changed from the
 * base takes its value (or is removed), any other key keeps `theirs`. A key
 * both changed to different values is a conflict. A value is compared whole
 * (a list or a nested map too).
 */
export function mergeFrontmatter(
  base: Record<string, unknown>,
  theirs: Record<string, unknown>,
  mine: Record<string, unknown>,
): FrontmatterMerge {
  const frontmatter = { ...theirs }
  const concurrent: string[] = []
  const conflicts: string[] = []
  for (const key of new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(mine)])) {
    // Own keys only: a key named like an Object method is absent, not that method.
    const [was, now, wanted] = [base, theirs, mine].map((map) => (Object.hasOwn(map, key) ? map[key] : undefined))
    const theyChanged = !isDeepStrictEqual(was, now)
    if (isDeepStrictEqual(was, wanted)) {
      if (theyChanged) concurrent.push(key)
    } else if (theyChanged && !isDeepStrictEqual(wanted, now)) {
      conflicts.push(key)
    } else if (Object.hasOwn(mine, key)) {
      frontmatter[key] = wanted
    } else {
      delete frontmatter[key]
    }
  }
  return { frontmatter, concurrent, conflicts }
}
