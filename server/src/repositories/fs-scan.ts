import { readFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import type { FileUpdate } from './store.js'

export const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|ico|webp|pdf|zip|tar|gz|7z|rar|exe|dll|so|dylib|bin|iso|dmg|apk|ipa|jar|war|class|pyc|pyo|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|avi|mov|webm|ogg|flac|mkv|wasm|dat|db|sqlite|sqlite3)$/i

/** Git's own metadata (a `.git` directory, or a submodule's `.git` file): always skipped, never reported. */
export const GIT_METADATA = /(^|\/)\.git(\/|$)/

/** A git or local-path scan indexes at most this many listed files; the rest are reported as `over_file_cap`. */
export const MAX_INDEXED_FILES = 10_000

/** Larger files are not indexed by a git or local-path scan (keeps a sync from exhausting the heap). */
export const MAX_FILE_BYTES = 1_048_576

/** Why a scan left a file out of the index. */
export type SkipReason = 'too_large' | 'binary' | 'ignored' | 'over_file_cap'

export interface SkippedFile {
  /** Relative to the repository root; an ignored directory ends in `/` and stands for everything under it. */
  path: string
  reason: SkipReason
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * `core.ignorecase` from the folder's `.git/config`. Git's default is false
 * (case-sensitive), and `ignore` would otherwise match case-insensitively and
 * drop `data/` for a `/Data/` rule; `git init` on a case-insensitive file
 * system (macOS, Windows) writes true, and then git matches either case.
 */
function gitIgnoreCase(root: string): boolean {
  const config = readOptional(join(root, '.git', 'config'))
  if (!config) return false
  let inCore = false
  let ignoreCase = false
  for (const line of config.split('\n')) {
    const section = /^\s*\[\s*([^\]\s"]+)/.exec(line)
    if (section) {
      inCore = section[1]!.toLowerCase() === 'core'
      continue
    }
    // A bare key is true; `true`/`yes`/`on`/`1` too.
    const entry = inCore ? /^\s*ignorecase\s*(?:=\s*([^\s;#]*))?\s*(?:[;#].*)?$/i.exec(line) : null
    if (entry) ignoreCase = entry[1] === undefined || /^(true|yes|on|1)$/i.test(entry[1])
  }
  return ignoreCase
}

/**
 * The ignore rules of a local folder, as git applies them (#465, D12):
 * `.git/info/exclude`, then the root `.gitignore`, then each nested
 * `.gitignore` down to the path, the deepest decisive rule winning (so a
 * nested `!keep.log` re-includes what the root's `*.log` excluded), matched
 * case-sensitively unless `.git/config` sets `core.ignorecase`. A folder
 * with no root `.gitignore` skips `node_modules/` as a safety default. A
 * directory's `.gitignore` is read once and cached; the watcher calls
 * `clear()` when a rule file changes. Sync reads: chokidar's `ignored` is
 * synchronous.
 */
export class GitignoreRules {
  private readonly dirs = new Map<string, Ignore | null>()
  private ignorecase = false
  private base: Ignore

  constructor(private readonly root: string) {
    this.base = this.loadBase()
  }

  clear(): void {
    this.dirs.clear()
    this.base = this.loadBase()
  }

  /** `relPath` is relative to the root, `/`-separated, never empty. */
  ignores(relPath: string, isDir: boolean): boolean {
    let ignored = false
    const apply = (rules: Ignore, path: string) => {
      const result = rules.test(isDir ? `${path}/` : path)
      if (result.ignored) ignored = true
      else if (result.unignored) ignored = false
    }
    apply(this.base, relPath)
    const parts = relPath.split('/')
    for (let i = 0; i < parts.length; i++) {
      const rules = this.rulesIn(parts.slice(0, i).join('/'))
      if (rules) apply(rules, parts.slice(i).join('/'))
    }
    return ignored
  }

  private loadBase(): Ignore {
    this.ignorecase = gitIgnoreCase(this.root)
    const base = ignore({ ignorecase: this.ignorecase })
    const exclude = readOptional(join(this.root, '.git', 'info', 'exclude'))
    if (exclude) base.add(exclude)
    if (this.rulesIn('') === null) base.add('node_modules/')
    return base
  }

  private rulesIn(dir: string): Ignore | null {
    let rules = this.dirs.get(dir)
    if (rules === undefined) {
      const text = readOptional(join(this.root, dir, '.gitignore'))
      rules = text === null ? null : ignore({ ignorecase: this.ignorecase }).add(text)
      this.dirs.set(dir, rules)
    }
    return rules
  }
}

/**
 * Every file path (relative to `root`) a scan should read, and what it left
 * out: `.git` always (unreported); with `rules`, what they ignore (a pruned
 * directory is one `ignored` entry); and binary assets by extension. Git
 * passes no rules: a clone holds only tracked files, and every tracked file
 * is source, a committed `build/` or `node_modules/` included (#465, D12).
 */
export async function listFilesRecursive(
  root: string,
  rules: GitignoreRules | null,
): Promise<{ paths: string[]; skipped: SkippedFile[] }> {
  const paths: string[] = []
  const skipped: SkippedFile[] = []

  // Ignored directories are pruned before descending (INGEST-07).
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const fullPath = join(dir, e.name)
      const relPath = relative(root, fullPath)
      if (GIT_METADATA.test(relPath)) continue
      const isDir = e.isDirectory()
      if (!isDir && !e.isFile()) continue
      if (rules?.ignores(relPath, isDir)) {
        skipped.push({ path: isDir ? `${relPath}/` : relPath, reason: 'ignored' })
      } else if (isDir) {
        await walk(fullPath)
      } else if (BINARY_EXTENSIONS.test(relPath)) {
        skipped.push({ path: relPath, reason: 'binary' })
      } else {
        paths.push(relPath)
      }
    }
  }

  await walk(root)
  return { paths, skipped }
}

export interface RepositoryScan {
  /** Content to hand to `syncRepositoryFiles`. */
  files: FileUpdate[]
  /** The paths that stay current: every listed path except the skipped ones. */
  currentPaths: string[]
  /** Files left out of the index, with the reason (summarised by `summarizeSkips`). */
  skipped: SkippedFile[]
}

/**
 * Reads the listed files of a git or local-path scan (`paths` relative to
 * `root`), one rule for both. A file over MAX_FILE_BYTES, or with a NUL byte
 * (taken as binary: a scan can't tell a stray NUL from a binary format), is
 * skipped and left out of `currentPaths` too, so the store deletes a row
 * indexed from an earlier version instead of serving it stale (#923). Agent
 * push is a different rule: the store strips NULs from pushed content.
 *
 * A file that fails to read (gone since the listing, no permission) stays
 * current, so its row is kept until a scan decides.
 */
export async function readRepositoryFiles(root: string, paths: string[], logTag: string): Promise<RepositoryScan> {
  const scan: RepositoryScan = { files: [], currentPaths: [], skipped: [] }
  for (const path of paths) {
    try {
      const fullPath = join(root, path)
      if ((await stat(fullPath)).size > MAX_FILE_BYTES) {
        scan.skipped.push({ path, reason: 'too_large' })
        continue
      }
      const bytes = await readFile(fullPath)
      // Only a 0x00 byte decodes to U+0000 in UTF-8, so a binary is never decoded.
      if (bytes.includes(0)) {
        scan.skipped.push({ path, reason: 'binary' })
        continue
      }
      scan.files.push({ path, content: bytes.toString('utf8') })
    } catch (err) {
      console.warn(`[${logTag}] failed reading repository file ${path} at ${root}:`, err)
    }
    scan.currentPaths.push(path)
  }
  return scan
}

/**
 * One full scan of a git clone (`rules` null) or a local folder (its
 * `GitignoreRules`): list, cap at `maxFiles` (the rest reported as
 * `over_file_cap` and left out of `currentPaths`), read. `skipped` holds
 * every reason, listing and reading alike.
 */
export async function scanRepository(
  root: string,
  rules: GitignoreRules | null,
  logTag: string,
  maxFiles = MAX_INDEXED_FILES,
): Promise<RepositoryScan> {
  const listed = await listFilesRecursive(root, rules)
  const scan = await readRepositoryFiles(root, listed.paths.slice(0, maxFiles), logTag)
  const overCap = listed.paths.slice(maxFiles).map((path): SkippedFile => ({ path, reason: 'over_file_cap' }))
  scan.skipped = [...listed.skipped, ...scan.skipped, ...overCap]
  return scan
}

/** Stored per repository (`repositories.skipped_files`) and served as `skipped`. */
export interface SkipSummary extends Record<SkipReason, number> {
  /** Up to SKIP_SAMPLE_PER_REASON paths per reason, in scan order. */
  sample: SkippedFile[]
}

/** 4 reasons × 5 = at most 20 sample paths: enough to see why, cheap in tokens. */
export const SKIP_SAMPLE_PER_REASON = 5

export function summarizeSkips(skipped: SkippedFile[]): SkipSummary {
  const summary: SkipSummary = { too_large: 0, binary: 0, ignored: 0, over_file_cap: 0, sample: [] }
  for (const file of skipped) {
    if (summary[file.reason]++ < SKIP_SAMPLE_PER_REASON) summary.sample.push(file)
  }
  return summary
}

/**
 * The `skipped` field of a status reply (MCP `repository_status`, the REST
 * repository row), spread into it: absent when the last sync skipped nothing
 * or none has recorded it, to keep the reply small.
 */
export function skippedField(summary: SkipSummary | null): { skipped?: SkipSummary } {
  if (!summary || summary.too_large + summary.binary + summary.ignored + summary.over_file_cap === 0) return {}
  return { skipped: summary }
}
