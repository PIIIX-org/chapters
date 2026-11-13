import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Persist directory entries (rename/unlink and newly created parent directories). */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export async function ensureDirectory(dir: string, durable = false): Promise<void> {
  const first = await mkdir(dir, { recursive: true })
  if (!durable || !first) return
  const stop = dirname(resolve(first))
  for (let current = resolve(dir); ; current = dirname(current)) {
    await syncDirectory(current)
    if (current === stop) break
  }
}

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
 * `durable`: sync the completed file before rename and directory entries
 * afterward (including newly created parents), before an external durable receipt.
 *
 * `beforeRename`: runs once the temp file is complete, before the rename (the
 * projector's `projector.after-tmp-before-rename` failpoint, ADR-003 §11).
 */
export async function atomicWrite(
  file: string,
  content: string | Uint8Array,
  options: { mode?: number; beforeRename?: () => void; durable?: boolean } = {},
): Promise<void> {
  await ensureDirectory(dirname(file), options.durable)
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    if (options.mode === undefined && !options.durable) {
      await writeFile(tmp, content)
    } else {
      const handle = await open(tmp, 'wx', options.mode ?? 0o666)
      try {
        if (options.mode !== undefined) await handle.chmod(options.mode)
        await handle.writeFile(content)
        if (options.durable) await handle.sync()
      } finally {
        await handle.close()
      }
    }
    options.beforeRename?.()
    await rename(tmp, file)
    if (options.durable) await syncDirectory(dirname(file))
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
