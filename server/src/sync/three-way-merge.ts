import { isDeepStrictEqual } from 'node:util'
import { diffLines, type LineHunk } from './text-diff.js'

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

/** `mine` merged onto `theirs`, both made from `base` (see the top of this file). */
export function mergeText(base: string, theirs: string, mine: string): TextMerge {
  const merged = mergeLines(base, theirs, mine, false)
  return merged.conflicts.length > 0 ? { text: null, conflicts: merged.conflicts } : { text: merged.text, concurrent: merged.concurrent }
}

/**
 * `mine` merged onto `theirs` where an overlap keeps `theirs`' lines instead
 * of refusing the merge (ADR-003 §5.4 rebase: acked typing, `theirs`, stays
 * in the text; `mine`, a row changed behind the store, stays recoverable
 * from its own revision). `overlaps` lists where `mine` was dropped.
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
    let lines = theirLines
    if (group.every((hunk) => !hunk.mine)) {
      concurrent.push(change)
    } else {
      lines = sideLines(baseLines, group, true, start, end)
      if (group.some((hunk) => !hunk.mine) && lines.join('') !== theirLines.join('')) {
        conflicts.push(change)
        if (keepTheirs) lines = theirLines
      }
    }
    for (const line of lines) out.push(line)
    shift += theirLines.length - (end - start)
    copied = end
  }
  for (let k = copied; k < baseLines.length; k++) out.push(baseLines[k]!)
  return { text: out.join(''), concurrent, conflicts }
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
