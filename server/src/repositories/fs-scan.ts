import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** Every file path (relative to `root`) not matching `ignore`. Shared by local-path and git-clone ingestion. */
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
        result.push(relPath)
      }
    }
  }

  await walk(root)
  return result
}
