/** The last queued holder of each key; a key with nothing queued has no entry. */
const tails = new Map<string, Promise<void>>()

/**
 * Runs `fn` while holding the lock for `key`. Callers of one key run one at a
 * time, in the order they called; callers of different keys never wait on
 * each other. Used to serialize read-modify-write sequences on one note.
 *
 * The lock is in-process only: the server is a single Node process per data
 * directory. Not reentrant: `fn` must not take the same key again, so nested
 * critical sections use distinct keys.
 */
export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous ? previous.then(() => held) : held
  tails.set(key, tail)
  try {
    if (previous) await previous
    return await fn()
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}
