import { posix } from 'node:path'

const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go']

/**
 * Best-effort resolution of a raw import specifier to a file that
 * actually exists in this repository (spec 9: "relative and common
 * alias patterns", not exhaustive module-resolution semantics).
 * Non-relative specifiers (npm packages, stdlib) never resolve — they
 * aren't files in this repository, so no edge is produced for them.
 */
export function resolveImportPath(
  sourcePath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null

  const base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier))
  const candidates = [
    base,
    ...CANDIDATE_EXTENSIONS.map((ext) => base + ext),
    ...CANDIDATE_EXTENSIONS.map((ext) => posix.join(base, 'index' + ext)),
  ]
  return candidates.find((c) => knownPaths.has(c)) ?? null
}
