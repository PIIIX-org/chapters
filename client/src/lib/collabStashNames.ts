/**
 * Where this browser keeps collab text the relay has not acknowledged (#720),
 * and the logout cleanup. No yjs here: the account menu, which is part of the
 * initial shell, imports {@link clearCollabStashes} from this module.
 *
 * One IndexedDB database per user + note (`<prefix>/<userId>/<vaultId>/<path>`):
 * the user id keeps one account's text out of another's session on a shared
 * browser, and logout deletes every database of that user. The names are also
 * kept in a localStorage index, because `indexedDB.databases()` is missing on
 * older engines (Firefox before 126).
 */
const PREFIX = 'elara-collab-stash'
const INDEX_KEY = `${PREFIX}/index`

export function collabStashName(userId: string, docName: string): string {
  return `${PREFIX}/${userId}/${docName}`
}

export function collabStashSupported(): boolean {
  return typeof indexedDB !== 'undefined'
}

/**
 * Runs `task` under a Web Lock when the engine has them (secure contexts), so
 * two tabs' read-modify-write of the index cannot drop each other's entry.
 */
function underLock(name: string, task: () => void): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) {
    task()
    return Promise.resolve()
  }
  return locks.request(name, () => task()).catch(() => task())
}

function readIndex(): string[] | null {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    const names: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return null
  }
}

function writeIndex(names: string[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(names))
  } catch {
    // Storage refused: the databases are still there, only harder to find.
  }
}

/** Records that a database for `name` exists. Best effort. */
export function rememberCollabStash(name: string): Promise<void> {
  return underLock(INDEX_KEY, () => {
    const names = readIndex()
    if (names && !names.includes(name)) writeIndex([...names, name])
  })
}

function forget(names: string[]): Promise<void> {
  return underLock(INDEX_KEY, () => {
    const index = readIndex()
    if (index) writeIndex(index.filter((n) => !names.includes(n)))
  })
}

/** True if a database for `name` may exist. Avoids creating one per note opened. */
export async function hasCollabStash(name: string): Promise<boolean> {
  if (!collabStashSupported()) return false
  if (typeof indexedDB.databases !== 'function') return readIndex()?.includes(name) ?? true
  try {
    return (await indexedDB.databases()).some((db) => db.name === name)
  } catch {
    return true
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    // A tab holds it open; its connection closes on `versionchange` (see
    // collabStash.ts) and the delete then completes on its own.
    request.onblocked = () => resolve()
  })
}

/**
 * Logout: nothing one user typed may be restored into anyone else's session
 * on this browser. Deletes every database of `userId` that
 * `indexedDB.databases()` or the localStorage index knows about. Open copies
 * (this tab or another) stop writing when their database is deleted.
 */
export async function clearCollabStashes(userId: string): Promise<void> {
  if (!collabStashSupported()) return
  const prefix = collabStashName(userId, '')
  const found = new Set(readIndex() ?? [])
  if (typeof indexedDB.databases === 'function') {
    for (const db of await indexedDB.databases().catch(() => [])) if (db.name) found.add(db.name)
  }
  const names = [...found].filter((name) => name.startsWith(prefix))
  await Promise.all(names.map((name) => deleteDatabase(name)))
  await forget(names)
}
