// File-count comparison text for checks that compare a repository's files
// with a reference run (#663): both counts always, and the paths only on
// either side when there are few enough to read in a check's `actual`.
// Plain TypeScript, no Bun globals (unit tests: file-diff.test.ts).

export interface FileDiff {
  files: number
  referenceFiles: number
  onlyHere: string[]
  onlyInReference: string[]
  /** e.g. `files 899 vs clean 894; only here (5): a, b, c, d, e; only in clean (0)` */
  text: string
}

export function fileDiff(reference: string[], other: string[], referenceLabel: string, maxListed = 20): FileDiff {
  const ref = new Set(reference)
  const here = new Set(other)
  const onlyHere = [...here].filter((p) => !ref.has(p)).sort()
  const onlyInReference = [...ref].filter((p) => !here.has(p)).sort()
  const list = (label: string, paths: string[]) =>
    paths.length === 0
      ? `${label} (0)`
      : `${label} (${paths.length}): ${paths.slice(0, maxListed).join(', ')}${paths.length > maxListed ? `, ... ${paths.length - maxListed} more` : ''}`
  return {
    files: other.length,
    referenceFiles: reference.length,
    onlyHere,
    onlyInReference,
    text:
      `files ${other.length} vs ${referenceLabel} ${reference.length}` +
      (onlyHere.length + onlyInReference.length === 0
        ? ', same paths'
        : `; ${list('only here', onlyHere)}; ${list(`only in ${referenceLabel}`, onlyInReference)}`),
  }
}
