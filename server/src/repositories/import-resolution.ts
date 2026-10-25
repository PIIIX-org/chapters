import { posix } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { detectLanguage } from './language.js'

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
 * The files a repository's `ResolutionContext` is built from (#466):
 * package.json, pnpm-workspace.yaml, tsconfig*.json and jsconfig*.json at any
 * depth. One pattern for JavaScript and for Postgres' `~`, which read it alike.
 */
export const RESOLUTION_MANIFEST_PATTERN = '(^|/)(package\\.json|pnpm-workspace\\.yaml|[jt]sconfig[^/]*\\.json)$'
const MANIFEST = new RegExp(RESOLUTION_MANIFEST_PATTERN)

export function isResolutionManifest(path: string): boolean {
  return MANIFEST.test(path)
}

/** The package.json fields resolution reads; any of them may be missing or of another type. */
type PackageManifest = Record<string, unknown>

/** One directory's tsconfig/jsconfig `compilerOptions`, repository-relative. */
interface PathAliases {
  /** Its files are those under this directory ('' = the repository root). */
  dir: string
  baseUrl: string | null
  /** `paths` patterns with their targets, joined to `baseUrl` (or the config's directory without one). */
  paths: Array<[pattern: string, targets: string[]]>
}

/**
 * What a repository's manifests say about its module names (#466), built by
 * `buildResolutionContext` from the indexed files that `isResolutionManifest`.
 */
export interface ResolutionContext {
  /** Workspace packages by package.json `name`: directory and manifest. */
  packages: Map<string, { dir: string; manifest: PackageManifest }>
  /** Every package.json by directory, for `#x` subpath imports. */
  manifests: Map<string, PackageManifest>
  /** tsconfig/jsconfig aliases per directory, deepest first. */
  aliases: PathAliases[]
}

const EMPTY_CONTEXT: ResolutionContext = { packages: new Map(), manifests: new Map(), aliases: [] }

/** A package's entry: `exports` conditions in this order, then any other condition, `types` last (a `.d.ts` is not the code). */
const CONDITION_ORDER = ['source', 'development', 'import', 'module', 'node', 'default', 'require', 'browser']
/** package.json fields naming the entry when `exports` resolves nothing. */
const ENTRY_FIELDS = ['source', 'module', 'main', 'types', 'typings']
/** Output directories a workspace package's entry points into, which a repository rarely contains: their source is under `src/`. */
const BUILD_DIRS = new Set(['dist', 'build', 'lib', 'out'])
/** A bundler's `?raw`, `?url`, `?worker` or `#hash` after the path (not a leading `#`: subpath imports). */
const QUERY_OR_HASH = /(?<=.)[?#].*$/s
/** The importers the resolution context applies to: JavaScript and TypeScript sources. */
const JS_SOURCE = /\.[cm]?[jt]sx?$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const dirOf = (path: string): string => {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}

const join = (dir: string, path: string): string => posix.normalize(posix.join(dir, path))

const isUnder = (dir: string, path: string): boolean => dir === '' || path.startsWith(`${dir}/`)

/**
 * Best-effort resolution of a raw import specifier to a file that
 * actually exists in this repository (spec 9: "relative and common
 * alias patterns", not exhaustive module-resolution semantics). Rust, Java,
 * Kotlin, C, C++, Ruby and PHP files resolve their own way
 * (`resolveByLanguage`, #464). Otherwise a `?query` or `#hash` suffix is
 * ignored (#466), and in order:
 * - relative specifiers, with TypeScript ESM `./x.js` -> `x.ts`/`x.tsx`
 *   (TS source preferred over a same-named `.js`);
 * - the `paths` of the nearest tsconfig/jsconfig above the importing file;
 *   a matching pattern that finds no file goes straight to the packages;
 * - `#x` by the nearest package.json `imports`;
 * - the `@/` alias, mapped by convention to the importing package's `src`
 *   directory;
 * - the nearest config's `baseUrl`;
 * - a workspace package by its package.json `name`, and its subpaths.
 * The context (all but relative specifiers and `@/`) applies to JS/TS
 * importers only. Anything else (npm packages, stdlib) never resolves.
 */
export function resolveImportPath(
  sourcePath: string,
  rawSpecifier: string,
  knownPaths: ReadonlySet<string>,
  context: ResolutionContext = EMPTY_CONTEXT,
): string | null {
  const own = resolveByLanguage(sourcePath, rawSpecifier, knownPaths)
  if (own !== undefined) return own
  const specifier = rawSpecifier.replace(QUERY_OR_HASH, '')
  if (specifier.startsWith('.')) return resolveFile(join(dirOf(sourcePath), specifier), knownPaths)
  // Manifests describe JavaScript module resolution: a Python or Go import never uses them.
  if (!JS_SOURCE.test(sourcePath)) context = EMPTY_CONTEXT

  const aliases = context.aliases.find((a) => isUnder(a.dir, sourcePath))
  const alias = aliases && matchPattern(aliases.paths, specifier)
  if (alias) {
    // As tsc: a matching pattern rules out the `@/` convention and `baseUrl`, but not a package (node_modules).
    for (const target of alias.value) {
      const resolved = resolveFile(target.replaceAll('*', alias.capture), knownPaths)
      if (resolved) return resolved
    }
    return resolvePackage(context, specifier, knownPaths)
  }
  if (specifier.startsWith('#')) return resolveSubpathImport(context, sourcePath, specifier, knownPaths)
  if (specifier.startsWith('@/')) {
    const segments = sourcePath.split('/')
    const srcIndex = segments.indexOf('src')
    if (srcIndex === -1) return null
    return resolveFile(join(segments.slice(0, srcIndex + 1).join('/'), specifier.slice(2)), knownPaths)
  }
  if (aliases?.baseUrl != null) {
    const resolved = resolveFile(join(aliases.baseUrl, specifier), knownPaths)
    if (resolved) return resolved
  }
  return resolvePackage(context, specifier, knownPaths)
}

/** `base` itself, with an extension, or its directory's index, as a known file. */
function resolveFile(base: string, knownPaths: ReadonlySet<string>): string | null {
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

/** The first of `candidates` that is a known file. */
const known = (knownPaths: ReadonlySet<string>, ...candidates: string[]): string | null => candidates.find((c) => knownPaths.has(c)) ?? null

/**
 * The imports of #464's languages, by the importing file's language;
 * undefined for the others. A standard library, an external crate, gem,
 * package or a system header never resolves:
 * - Rust `use`: `crate::` from the crate's `src`, `self::`/`super::` from
 *   the current module, anything else relative to the current module; the
 *   longest module path that is a file (`a/b.rs` or `a/b/mod.rs`) wins;
 * - Java and Kotlin `import a.b.C` (or a member `a.b.C.f`): a `.java`/`.kt`
 *   file whose path ends in `a/b/C`; not a wildcard;
 * - C/C++ `#include "x.h"`, Ruby `require_relative 'x'` (`.rb` optional),
 *   PHP `require 'x.php'`: relative to the importing file only.
 */
function resolveByLanguage(sourcePath: string, specifier: string, knownPaths: ReadonlySet<string>): string | null | undefined {
  switch (detectLanguage(sourcePath)) {
    case 'rust':
      return resolveRustPath(sourcePath, specifier, knownPaths)
    case 'java':
    case 'kotlin':
      return resolveJvmImport(specifier, knownPaths)
    case 'c':
    case 'cpp':
    case 'php':
      return known(knownPaths, join(dirOf(sourcePath), specifier))
    case 'ruby': {
      const path = join(dirOf(sourcePath), specifier)
      return known(knownPaths, path, `${path}.rb`)
    }
    default:
      return undefined
  }
}

function resolveRustPath(sourcePath: string, specifier: string, knownPaths: ReadonlySet<string>): string | null {
  const segments = specifier.split('::')
  // Where the current module's submodules are: `src/a/b.rs` has them in `src/a/b/`, `mod.rs`/`lib.rs`/`main.rs` beside it.
  const stem = posix.basename(sourcePath, '.rs')
  let base = ['mod', 'lib', 'main'].includes(stem) ? dirOf(sourcePath) : join(dirOf(sourcePath), stem)
  if (segments[0] === 'crate') {
    const parts = sourcePath.split('/')
    const src = parts.lastIndexOf('src', parts.length - 2)
    if (src === -1) return null
    base = parts.slice(0, src + 1).join('/')
    segments.shift()
  } else if (segments[0] === 'self') {
    segments.shift()
  } else {
    while (segments[0] === 'super') {
      base = dirOf(base)
      segments.shift()
    }
  }
  for (let n = segments.length; n >= 1; n--) {
    const module = join(base, segments.slice(0, n).join('/'))
    const found = known(knownPaths, `${module}.rs`, `${module}/mod.rs`)
    if (found) return found
  }
  return null
}

/** Each repository's Java/Kotlin files by every path suffix of two or more segments without the extension (`index/Entry`, `example/index/Entry`, ...). */
const jvmIndexes = new WeakMap<ReadonlySet<string>, Map<string, string>>()

function resolveJvmImport(specifier: string, knownPaths: ReadonlySet<string>): string | null {
  if (specifier.endsWith('*')) return null
  let index = jvmIndexes.get(knownPaths)
  if (!index) {
    index = new Map()
    for (const path of [...knownPaths].sort()) {
      const match = /\.(?:java|kts?)$/.exec(path)
      if (!match) continue
      const parts = path.slice(0, match.index).split('/')
      for (let from = parts.length - 2; from >= 0; from--) {
        const suffix = parts.slice(from).join('/')
        if (!index.has(suffix)) index.set(suffix, path)
      }
    }
    jvmIndexes.set(knownPaths, index)
  }
  const segments = specifier.split('.')
  for (let n = segments.length; n >= 2; n--) {
    const found = index.get(segments.slice(0, n).join('/'))
    if (found) return found
  }
  return null
}

/**
 * The value of `key` in a map whose keys may hold one `*` (tsconfig `paths`,
 * package.json `exports`/`imports`): the exact key, else the pattern with the
 * longest prefix that matches, with what its `*` stands for.
 */
function matchPattern<T>(entries: Iterable<[string, T]>, key: string): { value: T; capture: string } | null {
  let best: { value: T; capture: string; prefix: number } | null = null
  for (const [pattern, value] of entries) {
    const star = pattern.indexOf('*')
    if (star === -1) {
      if (pattern === key) return { value, capture: '' }
      continue
    }
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (key.length < prefix.length + suffix.length || !key.startsWith(prefix) || !key.endsWith(suffix)) continue
    if (!best || prefix.length > best.prefix) {
      best = { value, capture: key.slice(prefix.length, key.length - suffix.length), prefix: prefix.length }
    }
  }
  return best
}

/** The target paths of an `exports`/`imports` value: a string, fallbacks, or conditions (`CONDITION_ORDER`). */
function conditionTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(conditionTargets)
  if (!isRecord(value)) return []
  const rank = (condition: string) => {
    const i = CONDITION_ORDER.indexOf(condition)
    return i !== -1 ? i : condition === 'types' ? CONDITION_ORDER.length + 1 : CONDITION_ORDER.length
  }
  return Object.keys(value)
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((condition) => conditionTargets(value[condition]))
}

/** `exports` targets of `subpath` (`.` or `./x`): a string or a conditions object is the `.` entry; else a subpath map. */
function exportsTargets(exports: unknown, subpath: string): string[] {
  const isSubpathMap = isRecord(exports) && Object.keys(exports).some((k) => k.startsWith('.'))
  if (!isSubpathMap) return subpath === '.' ? conditionTargets(exports) : []
  const match = matchPattern(Object.entries(exports), subpath)
  return match ? conditionTargets(match.value).map((t) => t.replaceAll('*', match.capture)) : []
}

/**
 * A package-relative target as a known file: the target itself; a `.d.ts`
 * as its source next to it; a build output (`dist/`, `build/`, `lib/`,
 * `out/`) that is not in the repository as the same path under `src/`.
 */
function resolvePackageTarget(dir: string, target: string, knownPaths: ReadonlySet<string>): string | null {
  const path = join(dir, target)
  const stem = path.replace(/\.d\.[cm]?ts$/, '')
  const resolved = resolveFile(path, knownPaths) ?? (stem !== path ? resolveFile(stem, knownPaths) : null)
  if (resolved || !isUnder(dir, stem)) return resolved
  const [first, ...rest] = stem.slice(dir === '' ? 0 : dir.length + 1).split('/')
  return BUILD_DIRS.has(first!) && rest.length > 0 ? resolveFile(join(dir, ['src', ...rest].join('/')), knownPaths) : null
}

/**
 * A workspace package (`@scope/pkg`, `pkg`) by its entry: `exports['.']`,
 * then `ENTRY_FIELDS`, then `index`/`src/index`; a subpath (`@scope/pkg/a/b`)
 * by `exports['./a/b']` (patterns included), then `a/b` and `src/a/b` in the
 * package. Not a workspace package's name: null.
 */
function resolvePackage(context: ResolutionContext, specifier: string, knownPaths: ReadonlySet<string>): string | null {
  const segments = specifier.split('/')
  const nameLength = specifier.startsWith('@') ? 2 : 1
  const pkg = context.packages.get(segments.slice(0, nameLength).join('/'))
  if (!pkg) return null
  const subpath = segments.slice(nameLength).join('/')
  const { dir, manifest } = pkg
  const targets =
    subpath === ''
      ? [
          ...exportsTargets(manifest.exports, '.'),
          ...ENTRY_FIELDS.map((field) => manifest[field]).filter((t): t is string => typeof t === 'string'),
          'index',
          'src/index',
        ]
      : [...exportsTargets(manifest.exports, `./${subpath}`), subpath, `src/${subpath}`]
  for (const target of targets) {
    const resolved = resolvePackageTarget(dir, target, knownPaths)
    if (resolved) return resolved
  }
  return null
}

/** `#x` by the `imports` of the package.json nearest the importing file (Node subpath imports). */
function resolveSubpathImport(
  context: ResolutionContext,
  sourcePath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  for (let dir = dirOf(sourcePath); ; dir = dirOf(dir)) {
    const manifest = context.manifests.get(dir)
    if (manifest) {
      const match = isRecord(manifest.imports) ? matchPattern(Object.entries(manifest.imports), specifier) : null
      for (const target of match ? conditionTargets(match.value) : []) {
        if (!target.startsWith('./')) continue
        const resolved = resolvePackageTarget(dir, target.replaceAll('*', match!.capture), knownPaths)
        if (resolved) return resolved
      }
      return null
    }
    if (dir === '') return null
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** tsconfig's dialect: JSON with `//` and block comments and trailing commas. */
function parseJsonc(text: string): unknown {
  let json = ''
  let comma = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end - 1
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
    } else if (/\s/.test(c)) {
      json += c
    } else {
      // A comma is written once the next token shows it is not trailing.
      if (comma && c !== '}' && c !== ']') json += ','
      comma = c === ','
      if (c === '"') {
        const start = i
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
        json += text.slice(start, i + 1)
      } else if (!comma) {
        json += c
      }
    }
  }
  return parseJson(json)
}

/** A workspace glob (`packages/*`, `apps/**`) as a regular expression over directory paths. */
function globRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.\//, '').replace(/\/+$/, '')
  let source = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*' && g[i + 1] === '*') {
      // `**/` is any number of directories; a final `**` anything below.
      source += g[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += g[i + 2] === '/' ? 2 : 1
    } else if (c === '*') {
      source += '[^/]*'
    } else if (c === '?') {
      source += '[^/]'
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * The resolution context of a repository from its manifests (#466); other
 * paths and files that do not parse are ignored.
 *
 * Workspace packages: every package.json with a `name`, unless the
 * repository declares workspaces (pnpm-workspace.yaml `packages`,
 * package.json `workspaces` as an array or `{ packages }`): then only the
 * declaring roots and the directories their globs select (`!` globs
 * exclude). A name two packages share goes to the first by path.
 * Dependencies are not checked: any file may import any workspace package.
 *
 * Path aliases: tsconfig*.json and jsconfig*.json `compilerOptions.paths`
 * and `baseUrl` apply to the files under the config's directory; the
 * nearest directory with either wins, its configs merged (`tsconfig.json`
 * and `jsconfig.json` first, then by name; a pattern's first definition
 * counts). `extends` is not followed.
 */
export function buildResolutionContext(files: Iterable<{ path: string; content: string }>): ResolutionContext {
  const packageJsons: Array<{ dir: string; manifest: PackageManifest }> = []
  const workspaces: Array<{ dir: string; globs: string[] }> = []
  const configs: Array<{ dir: string; name: string; options: Record<string, unknown> }> = []
  const addWorkspace = (dir: string, globs: unknown) => {
    if (Array.isArray(globs)) workspaces.push({ dir, globs: globs.filter((g): g is string => typeof g === 'string') })
  }

  for (const { path, content } of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (!isResolutionManifest(path)) continue
    const dir = dirOf(path)
    const name = posix.basename(path)
    if (name === 'package.json') {
      const manifest = parseJson(content)
      if (!isRecord(manifest)) continue
      packageJsons.push({ dir, manifest })
      addWorkspace(dir, isRecord(manifest.workspaces) ? manifest.workspaces.packages : manifest.workspaces)
    } else if (name === 'pnpm-workspace.yaml') {
      let doc: unknown
      try {
        doc = parseYaml(content)
      } catch {
        continue
      }
      if (isRecord(doc)) addWorkspace(dir, doc.packages)
    } else {
      const config = parseJsonc(content)
      if (isRecord(config) && isRecord(config.compilerOptions)) configs.push({ dir, name, options: config.compilerOptions })
    }
  }

  const roots = workspaces.map(({ dir, globs }) => ({
    dir,
    include: globs.filter((g) => !g.startsWith('!')).map(globRegExp),
    exclude: globs.filter((g) => g.startsWith('!')).map((g) => globRegExp(g.slice(1))),
  }))
  const isWorkspacePackage = (dir: string) =>
    roots.length === 0 ||
    roots.some((root) => {
      if (root.dir === dir) return true
      if (!isUnder(root.dir, dir)) return false
      const rel = dir.slice(root.dir === '' ? 0 : root.dir.length + 1)
      return root.include.some((re) => re.test(rel)) && !root.exclude.some((re) => re.test(rel))
    })

  const context: ResolutionContext = { packages: new Map(), manifests: new Map(), aliases: [] }
  for (const { dir, manifest } of packageJsons) {
    context.manifests.set(dir, manifest)
    if (typeof manifest.name === 'string' && !context.packages.has(manifest.name) && isWorkspacePackage(dir)) {
      context.packages.set(manifest.name, { dir, manifest })
    }
  }

  // By directory, then the directory's tsconfig.json/jsconfig.json before its other configs, then by name.
  const configRank = (name: string) => (name === 'tsconfig.json' || name === 'jsconfig.json' ? 0 : 1)
  configs.sort((a, b) =>
    a.dir !== b.dir ? (a.dir < b.dir ? -1 : 1) : configRank(a.name) - configRank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
  const byDir = new Map<string, PathAliases>()
  for (const { dir, options } of configs) {
    const baseUrl = typeof options.baseUrl === 'string' ? join(dir, options.baseUrl) : null
    const paths = isRecord(options.paths) ? Object.entries(options.paths) : []
    if (baseUrl === null && paths.length === 0) continue
    let aliases = byDir.get(dir)
    if (!aliases) byDir.set(dir, (aliases = { dir, baseUrl: null, paths: [] }))
    aliases.baseUrl ??= baseUrl
    for (const [pattern, targets] of paths) {
      if (!Array.isArray(targets) || aliases.paths.some(([p]) => p === pattern)) continue
      const base = baseUrl ?? dir
      aliases.paths.push([pattern, targets.filter((t): t is string => typeof t === 'string').map((t) => join(base, t))])
    }
  }
  context.aliases = [...byDir.values()].sort((a, b) => b.dir.length - a.dir.length)
  return context
}
