import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** Every file path (relative to `root`) not matching `ignore`. Shared by local-path and git-clone ingestion. */
export async function listFilesRecursive(root: string, ignore: RegExp): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .filter((p) => !ignore.test(p))
}
