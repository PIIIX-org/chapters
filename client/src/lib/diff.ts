export type DiffType = 'add' | 'remove' | 'same'

export interface DiffLine {
  type: DiffType
  text: string
  oldLineNumber?: number
  newLineNumber?: number
}

/**
 * Computes a line-by-line unified diff between oldText and newText using
 * Longest Common Subsequence (LCS).
 *
 * 'remove' indicates a line present in oldText but not newText.
 * 'add' indicates a line present in newText but not oldText.
 * 'same' indicates an unchanged line.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  if (oldText === '' && newText === '') return []

  const oldLines = oldText === '' ? [] : oldText.split('\n')
  const newLines = newText === '' ? [] : newText.split('\n')

  if (oldLines.length === 0) {
    return newLines.map((text, idx) => ({
      type: 'add',
      text,
      newLineNumber: idx + 1,
    }))
  }

  if (newLines.length === 0) {
    return oldLines.map((text, idx) => ({
      type: 'remove',
      text,
      oldLineNumber: idx + 1,
    }))
  }

  if (oldText === newText) {
    return oldLines.map((text, idx) => ({
      type: 'same',
      text,
      oldLineNumber: idx + 1,
      newLineNumber: idx + 1,
    }))
  }

  const m = oldLines.length
  const n = newLines.length

  // ponytail: O(m*n) LCS table ceiling for huge inputs (> 500k cells); falls back to naive line compare
  if (m * n > 500_000) {
    const lines: DiffLine[] = []
    const maxLen = Math.max(m, n)
    for (let k = 0; k < maxLen; k++) {
      const o = oldLines[k]
      const nw = newLines[k]
      if (o !== undefined && nw !== undefined) {
        if (o === nw) {
          lines.push({ type: 'same', text: o, oldLineNumber: k + 1, newLineNumber: k + 1 })
        } else {
          lines.push({ type: 'remove', text: o, oldLineNumber: k + 1 })
          lines.push({ type: 'add', text: nw, newLineNumber: k + 1 })
        }
      } else if (o !== undefined) {
        lines.push({ type: 'remove', text: o, oldLineNumber: k + 1 })
      } else if (nw !== undefined) {
        lines.push({ type: 'add', text: nw, newLineNumber: k + 1 })
      }
    }
    return lines
  }

  // Standard dynamic programming table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    const rowPrev = dp[i - 1]!
    const rowCurr = dp[i]!
    const oldLine = oldLines[i - 1]!
    for (let j = 1; j <= n; j++) {
      if (oldLine === newLines[j - 1]!) {
        rowCurr[j] = rowPrev[j - 1]! + 1
      } else {
        rowCurr[j] = Math.max(rowPrev[j]!, rowCurr[j - 1]!)
      }
    }
  }

  const diff: DiffLine[] = []
  let i = m
  let j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1]! === newLines[j - 1]!) {
      diff.unshift({
        type: 'same',
        text: oldLines[i - 1]!,
        oldLineNumber: i,
        newLineNumber: j,
      })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      diff.unshift({
        type: 'add',
        text: newLines[j - 1]!,
        newLineNumber: j,
      })
      j--
    } else if (i > 0) {
      diff.unshift({
        type: 'remove',
        text: oldLines[i - 1]!,
        oldLineNumber: i,
      })
      i--
    }
  }

  return diff
}
