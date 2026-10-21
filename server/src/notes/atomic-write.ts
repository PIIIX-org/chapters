import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
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
 *
 * `mode`: the file's permission bits whatever the umask. The temp file is
 * created with them and chmodded before any content goes in, so the content
 * is never on disk with looser permissions (#493).
 *
 * `beforeRename`: runs once the temp file is complete, before the rename (the
 * projector's `projector.after-tmp-before-rename` failpoint, ADR-003 §11).
 */
export async function atomicWrite(
  file: string,
  content: string | Uint8Array,
  options: { mode?: number; beforeRename?: () => void } = {},
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    if (options.mode === undefined) {
      await writeFile(tmp, content)
    } else {
      const handle = await open(tmp, 'wx', options.mode)
      try {
        await handle.chmod(options.mode)
        await handle.writeFile(content)
      } finally {
        await handle.close()
      }
    }
    options.beforeRename?.()
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
