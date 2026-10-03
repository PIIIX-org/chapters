import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

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
