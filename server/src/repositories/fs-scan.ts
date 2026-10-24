import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { FileUpdate } from './store.js'

export const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|ico|webp|pdf|zip|tar|gz|7z|rar|exe|dll|so|dylib|bin|iso|dmg|apk|ipa|jar|war|class|pyc|pyo|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|avi|mov|webm|ogg|flac|mkv|wasm|dat|db|sqlite|sqlite3)$/i

/** Every file path (relative to `root`) not matching `ignore` and not a binary asset. Shared by local-path and git-clone ingestion. */
export async function listFilesRecursive(root: string, ignore: RegExp): Promise<string[]> {
  const result: string[] = []

  // ponytail: prune directories matching ignore regex before descending to avoid walking node_modules/.git (INGEST-07).
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const fullPath = join(dir, e.name)
      const relPath = relative(root, fullPath)
      if (ignore.test(relPath)) continue

      if (e.isDirectory()) {
        await walk(fullPath)
      } else if (e.isFile()) {
        if (!BINARY_EXTENSIONS.test(relPath)) {
          result.push(relPath)
        }
      }
    }
  }

  await walk(root)
  return result
}

/** Larger files are not indexed by a git or local-path scan (keeps a sync from exhausting the heap). */
export const MAX_FILE_BYTES = 1_048_576

/** Why a scan left a listed file out of the index. */
export type SkipReason = 'too_large' | 'binary'

export interface RepositoryScan {
  /** Content to hand to `syncRepositoryFiles`. */
  files: FileUpdate[]
  /** The paths that stay current: every listed path except the skipped ones. */
  currentPaths: string[]
  /** Listed files left out of the index, with the reason (the seam #465 reports from). */
  skipped: Array<{ path: string; reason: SkipReason }>
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
