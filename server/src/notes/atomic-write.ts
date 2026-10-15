import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Replaces `file` all at once: the content goes to a sibling temp file that is
 * then renamed over it, so a crash never leaves a half-written file.
 *
 * The temp name is unique to each call (process id + random suffix). With a
 * fixed `${file}.tmp`, two concurrent writes of one file shared it: the second
 * truncated the first's temp mid-write, and whichever renamed second found it
 * gone and failed with ENOENT. Each write now renames only its own temp, so
 * the last rename wins whole.
 */
export async function atomicWrite(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, content)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
