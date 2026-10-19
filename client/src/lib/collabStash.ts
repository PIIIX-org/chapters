import * as Y from 'yjs'
import { IndexeddbPersistence, storeState } from 'y-indexeddb'

/**
 * This browser's copy of collab edits the relay has not acknowledged yet
 * (#720). Without it the note's `Y.Doc` lives only in the tab, and a reload or
 * a closed tab while the socket is down throws the typing away.
 *
 * One IndexedDB database per user + note (`<prefix>/<userId>/<vaultId>/<path>`):
 * the user id keeps one account's text out of another's session on a shared
 * browser, and logout deletes every database of that user
 * ({@link clearCollabStashes}). Their names are also kept in localStorage.
 *
 * A store holds a full document state (y-indexeddb writes the whole doc when it
 * opens, then every update), so it can be shown on its own after a reload with
 * the relay unreachable. It is only kept while something local is unsent: once
 * the relay has acknowledged everything, {@link releaseCollabStash} empties it.
 * Emptying is a `clear()` of the store, never `deleteDatabase`, which would
 * close the database under another tab that still writes to it.
 */
const PREFIX = 'elara-collab-stash'

export function collabStashName(userId: string, docName: string): string {
  return `${PREFIX}/${userId}/${docName}`
}

function supported(): boolean {
  return typeof indexedDB !== 'undefined'
}

/**
 * y-indexeddb with two lifecycle changes:
 *
 * - Its write runs inside the doc's `update` event, so a write that throws
 *   (the database was closed under it: logout in another tab deletes it, and
 *   lib0 closes on `versionchange`) would throw out of the user's keystroke.
 *   The local copy stopping is recoverable; a keystroke that fails is not.
 * - It destroys itself when the doc is destroyed, which on unmount can be
 *   before its first write landed. The handle below closes it instead, after
 *   that write.
 */
class Persistence extends IndexeddbPersistence {
  constructor(name: string, doc: Y.Doc) {
    super(name, doc)
    doc.off('destroy', this.destroy)
    doc.off('update', this._storeUpdate)
    const store = this._storeUpdate
    this._storeUpdate = (update, origin) => {
      try {
        store(update, origin)
      } catch {
        // The database is gone; the document keeps working.
      }
    }
    doc.on('update', this._storeUpdate)
  }
}

/**
 * Every open, clear and delete of one database runs in call order. A clear
 * that lands after a reopen's first write would wipe a copy that was just
 * made; serialising them makes the reopen write the whole document after it.
 */
const queues = new Map<string, Promise<unknown>>()
function serial<T>(name: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(name) ?? Promise.resolve()).then(task, task)
  const tail = run.catch(() => undefined)
  queues.set(name, tail)
  void tail.then(() => {
    if (queues.get(name) === tail) queues.delete(name)
  })
  return run
}

export interface CollabStash {
  readonly name: string
  readonly doc: Y.Doc
  /** Resolves once the stored updates are in `doc` and `doc` is stored. */
  readonly loaded: Promise<void>
}

class Handle implements CollabStash {
  persistence: Persistence | null = null
  closed = false
  /** Set while the copy is held for the "not merged" notice: see {@link holdCollabStash}. */
  onDiscarded: (() => void) | null = null
  readonly loaded: Promise<void>

  constructor(
    readonly name: string,
    readonly doc: Y.Doc,
  ) {
    live.add(this)
    remember(name)
    // Opens even if closed before its turn came: closing right after a
    // keystroke (unmount) must still write that keystroke down first.
    this.loaded = serial(name, async () => {
      const persistence = new Persistence(name, doc)
      this.persistence = persistence
      await persistence._db
      await persistence.whenSynced
    })
  }

  /**
   * Another copy emptied the store. An unsent copy writes its whole document
   * back. A copy held for the notice never does: it shares no history with the
   * note, and back in the store it would reach a live document and put the
   * note in twice. A discard ends the notice everywhere.
   */
  emptied(discarded: boolean): void {
    if (this.onDiscarded) {
      if (discarded) this.onDiscarded()
      return
    }
    void serial(this.name, async () => {
      if (!this.closed && this.persistence?.db) await storeState(this.persistence, true)
    })
  }
}

const live = new Set<Handle>()

interface Emptied {
  name: string
  discarded: boolean
}

function emptied({ name, discarded }: Emptied): void {
  for (const handle of [...live]) if (handle.name === name) handle.emptied(discarded)
}

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(PREFIX)
if (channel) {
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data as Partial<Emptied> | null
    if (typeof data?.name === 'string') emptied({ name: data.name, discarded: data.discarded === true })
  }
}

/**
 * The names of the stores this browser has opened, in localStorage: logout
 * and {@link hasCollabStash} need them, and `indexedDB.databases()` is missing
 * on older engines (Firefox before 126). Best effort: storage may be refused.
 */
const INDEX_KEY = `${PREFIX}/index`

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

function remember(name: string): void {
  const names = readIndex()
  if (names && !names.includes(name)) writeIndex([...names, name])
}

function forget(names: string[]): void {
  const index = readIndex()
  if (index) writeIndex(index.filter((n) => !names.includes(n)))
}

/**
 * Starts keeping `doc` in this browser: loads what is stored into it (now and
 * whenever the store is compacted or rewritten), then stores every update.
 * Never open it on a document the relay syncs: what is stored can come from
 * another history, and loaded unchecked it goes to the relay (see
 * `useCollabDoc`, which opens it on a separate doc and merges only after a
 * history check).
 */
export function openCollabStash(name: string, doc: Y.Doc): CollabStash | null {
  if (!supported()) return null
  return new Handle(name, doc)
}

/** True if a database for `name` may exist. Avoids creating one per note opened. */
export async function hasCollabStash(name: string): Promise<boolean> {
  if (!supported()) return false
  if (typeof indexedDB.databases !== 'function') return readIndex()?.includes(name) ?? true
  try {
    return (await indexedDB.databases()).some((db) => db.name === name)
  } catch {
    return true
  }
}

/**
 * Holds a copy for the "not merged" notice: it is never written back into the
 * store, and `onDiscarded` runs when the person discards it in another tab.
 */
export function holdCollabStash(stash: CollabStash, onDiscarded: () => void): void {
  ;(stash as Handle).onDiscarded = onDiscarded
}

/** Stops writing and keeps what is stored: something in it is still unsent. */
export function closeCollabStash(stash: CollabStash): Promise<void> {
  const handle = stash as Handle
  if (handle.closed) return Promise.resolve()
  handle.closed = true
  live.delete(handle)
  return serial(handle.name, async () => {
    await handle.persistence?.destroy()
  })
}

function empty(stash: CollabStash, discarded: boolean): Promise<void> {
  const handle = stash as Handle
  if (handle.closed) return Promise.resolve()
  handle.closed = true
  live.delete(handle)
  return serial(handle.name, async () => {
    const persistence = handle.persistence
    if (!persistence?.db) return
    await new Promise<void>((resolve, reject) => {
      const tx = persistence.db!.transaction('updates', 'readwrite')
      tx.objectStore('updates').clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clear failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB clear aborted'))
    })
    await persistence.destroy()
    const message: Emptied = { name: handle.name, discarded }
    emptied(message)
    channel?.postMessage(message)
  })
}

/**
 * The relay has acknowledged everything: empty the store and stop writing.
 * Any other unsent copy of the same note still open (another tab) writes its
 * whole document back, so emptying never drops text that tab has not sent.
 */
export function releaseCollabStash(stash: CollabStash): Promise<void> {
  return empty(stash, false)
}

/** The person discarded the copy behind the notice: empty the store, end the notice in every tab. */
export function discardCollabStash(stash: CollabStash): Promise<void> {
  return empty(stash, true)
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    // Another tab holds it open; it closes on `versionchange` and the delete
    // then completes on its own. Waiting here would stall this queue.
    request.onblocked = () => resolve()
  })
}

/**
 * Logout: nothing one user typed may be restored into anyone else's session
 * on this browser. Deletes every database of `userId` that
 * `indexedDB.databases()` or the localStorage index knows about.
 */
export async function clearCollabStashes(userId: string): Promise<void> {
  if (!supported()) return
  const prefix = collabStashName(userId, '')
  await Promise.all([...live].filter((h) => h.name.startsWith(prefix)).map((h) => closeCollabStash(h)))
  const found = new Set(readIndex() ?? [])
  if (typeof indexedDB.databases === 'function') {
    for (const db of await indexedDB.databases().catch(() => [])) if (db.name) found.add(db.name)
  }
  const names = [...found].filter((name) => name.startsWith(prefix))
  await Promise.all(names.map((name) => serial(name, () => deleteDatabase(name))))
  forget(names)
}
