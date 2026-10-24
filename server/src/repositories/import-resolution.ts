import { posix } from 'node:path'

/** Tried in order for an extensionless specifier: TypeScript sources before the JavaScript they compile to (#451). */
const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go']

/** TypeScript ESM: a `.js`-style specifier names the compiled output of a TS source. */
const TS_SOURCE_EXTENSIONS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}

/**
 * Best-effort resolution of a raw import specifier to a file that
 * actually exists in this repository (spec 9: "relative and common
 * alias patterns", not exhaustive module-resolution semantics).
 * Handles relative specifiers, TypeScript ESM `./x.js` -> `x.ts`/`x.tsx`
 * (TS source preferred over a same-named `.js`), and the `@/` alias,
 * mapped by convention to the importing package's `src` directory.
 * Other non-relative specifiers (npm packages, stdlib) never resolve.
 */
export function resolveImportPath(
  sourcePath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  let base: string
  if (specifier.startsWith('.')) {
    base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier))
  } else if (specifier.startsWith('@/')) {
    const segments = sourcePath.split('/')
    const srcIndex = segments.indexOf('src')
    if (srcIndex === -1) return null
    base = posix.normalize(posix.join(...segments.slice(0, srcIndex + 1), specifier.slice(2)))
  } else {
    return null
  }

  const ext = posix.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  const candidates = [
    ...(TS_SOURCE_EXTENSIONS[ext] ?? []).map((tsExt) => stem + tsExt),
    base,
    ...CANDIDATE_EXTENSIONS.map((e) => base + e),
    ...CANDIDATE_EXTENSIONS.map((e) => posix.join(base, 'index' + e)),
  ]
  return candidates.find((c) => knownPaths.has(c)) ?? null
}
