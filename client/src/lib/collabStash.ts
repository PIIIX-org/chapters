import * as Y from 'yjs'
import { collabStashSupported, rememberCollabStash } from './collabStashNames.js'

/**
 * This browser's copies of collab documents with edits the relay has not
 * acknowledged yet (#720). Without them the note's `Y.Doc` lives only in the
 * tab, and a reload or a closed tab while the socket is down throws the
 * typing away. Database names and logout: `collabStashNames.ts`.
 *
 * Every record belongs to one **copy**: one `Y.Doc` in one tab (a tab's live
 * document, or a copy it restored). A copy is written by that doc alone, as a
 * whole-state record followed by its updates, and nothing is ever read back
 * into a doc that is being kept. So each copy is one document's history, never
 * a mixture: two unrelated documents (the note before and after it was
 * re-created on the server) can sit in the same database without one leaking
 * into the other, and a later session checks each copy on its own before
 * merging it.
 *
 * A copy is only kept while something in it is unsent. Once the relay has
 * acknowledged everything, its tab deletes that copy's records and nobody
 * else's. While its tab is open, the copy holds a Web Lock, so other tabs leave
 * it alone; when the tab closes or crashes the lock goes with it, and the next
 * tab to open the note claims the copy ({@link claimLeftoverCopies}). Tabs
 * already open on the note wait for the locks of the copies they saw held, and
 * the first one to get a lock claims that copy at once (#766).
 *
 * Without Web Locks (Safari < 15.4, Firefox < 96, plain-http origins) a tab
 * only knows its own copies are taken: it can claim another open tab's copy,
 * and nothing tells open tabs that a copy was left. A copy left by a closed
 * tab then waits for the next visit to the note, and a copy discarded in one
 * tab while its old owner is still writing to it can be stored again by that
 * owner and offered once more on the next visit (never merged twice: copies
 * meet the relay's document through the same history check).
 */
const STORE = 'updates'
const BY_COPY = 'copy'
/** A copy with this many records is rewritten as one. */
const COMPACT_AT = 500

interface Row {
  copy: string
  update: Uint8Array
}

export interface CollabCopy {
  readonly doc: Y.Doc
  /** Resolves once everything in `doc` so far is written: true if it is
   *  stored, false if the last write failed (storage full, say). */
  flushed(): Promise<boolean>
  /** Stops writing and keeps what is stored: something in it is still unsent. */
  close(): Promise<void>
  /** Stops writing and deletes the copy: it was sent, merged or discarded. */
  release(): Promise<void>
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function openDatabase(name: string, onGone: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { autoIncrement: true }).createIndex(BY_COPY, 'copy')
    }
    request.onsuccess = () => {
      const db = request.result
      // Logout deletes the database: let it, and stop writing.
      db.onversionchange = () => {
        db.close()
        onGone()
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

/** Locks held by this tab, for engines without Web Locks (plain-http origins). */
const heldHere = new Set<string>()

/**
 * Takes the lock on a copy if nobody holds it, for as long as this tab keeps
 * the copy. Without Web Locks only this tab's own copies count as taken.
 * With `waitFor`, waits until the lock is free instead (null once the signal
 * aborts); without Web Locks there is nothing to wait for and it gives null.
 */
function claim(lock: string, waitFor?: AbortSignal): Promise<(() => void) | null> {
  if (!waitFor && heldHere.has(lock)) return Promise.resolve(null)
  const taken = () => {
    heldHere.add(lock)
    return () => {
      heldHere.delete(lock)
    }
  }
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) return Promise.resolve(waitFor ? null : taken())
  const options: LockOptions = waitFor ? { signal: waitFor } : { ifAvailable: true }
  return new Promise((resolve) => {
    locks
      .request(lock, options, (granted) => {
        if (!granted) {
          resolve(null)
          return undefined
        }
        const free = taken()
        // Held until the returned promise settles.
        return new Promise<void>((release) => {
          resolve(() => {
            free()
            release()
          })
        })
      })
      // Aborted while waiting: nothing taken.
      .catch(() => resolve(waitFor ? null : taken()))
  })
}

function newCopyId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
}

class Copy implements CollabCopy {
  private db: IDBDatabase | null = null
  /** The database was deleted under this copy (logout): it stops writing. */
  private gone = false
  private stopped = false
  private queue: Promise<void> = Promise.resolve()
  private pending: Uint8Array[] = []
  private scheduled = false
  /** False while the last write failed: part of `doc` is not stored. */
  private stored = true
  /** This copy's records, oldest first; `base` is its latest whole-state record. */
  private keys: IDBValidKey[]
  private base: IDBValidKey | null

  constructor(
    private readonly name: string,
    readonly doc: Y.Doc,
    private readonly id: string,
    private unlock: (() => void) | null,
    loaded: IDBValidKey[],
  ) {
    this.keys = loaded
    this.base = loaded[0] ?? null
    doc.on('update', this.onUpdate)
    if (this.base === null) this.schedule()
  }

  private readonly onUpdate = (update: Uint8Array) => {
    if (this.stopped) return
    this.pending.push(update)
    this.schedule()
  }

  private run(task: () => Promise<void>): Promise<void> {
    // A failed write leaves the text in the document; the copy stops short of it.
    this.queue = this.queue.then(task).catch(() => undefined)
    return this.queue
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    void this.run(async () => {
      this.scheduled = false
      try {
        await this.write()
        this.stored = true
      } catch (error) {
        this.stored = false
        throw error
      }
    })
  }

  private async connect(): Promise<IDBDatabase | null> {
    if (this.gone) return null
    if (this.db) return this.db
    // Held before the first record lands, so no other tab takes this copy
    // for a left-over one.
    this.unlock ??= await claim(`${this.name}#${this.id}`)
    this.db = await openDatabase(this.name, () => {
      this.gone = true
      this.db = null
    })
    void rememberCollabStash(this.name)
    return this.db
  }

  /**
   * Appends what changed since the last write. Writes the whole document
   * instead (and drops this copy's older records) the first time, every
   * {@link COMPACT_AT} records, and when this copy's whole-state record is gone:
   * without Web Locks another tab can take a copy that is still open, merge it
   * and delete it, and what follows must not be updates on a missing base.
   */
  private async write(): Promise<void> {
    const updates = this.pending
    this.pending = []
    const db = await this.connect()
    if (!db) return
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const added: IDBValidKey[] = []
    let whole: IDBValidKey | null = null
    const add = (update: Uint8Array, isWhole: boolean) => {
      const request = store.add({ copy: this.id, update } satisfies Row)
      request.onsuccess = () => {
        if (isWhole) whole = request.result
        else added.push(request.result)
      }
    }
    const writeWhole = () => {
      add(Y.encodeStateAsUpdate(this.doc), true)
      for (const key of this.keys) store.delete(key)
    }
    if (this.base === null || this.keys.length >= COMPACT_AT) writeWhole()
    else {
      const check = store.count(this.base)
      check.onsuccess = () => {
        if (check.result === 0) writeWhole()
        else if (updates.length > 0) add(Y.mergeUpdates(updates), false)
      }
    }
    try {
      await done(tx)
    } catch (error) {
      // Not knowing what landed, the next write stores the whole document.
      this.base = null
      throw error
    }
    if (whole !== null) {
      this.base = whole
      this.keys = [whole]
    } else this.keys.push(...added)
  }

  private stop(): void {
    this.stopped = true
    this.doc.off('update', this.onUpdate)
  }

  private finish(): void {
    this.db?.close()
    this.db = null
    this.unlock?.()
    this.unlock = null
  }

  flushed(): Promise<boolean> {
    return this.queue.then(() => this.stored)
  }

  close(): Promise<void> {
    if (this.stopped) return this.queue
    this.stop()
    return this.run(async () => {
      try {
        if (!this.gone) await this.write()
      } finally {
        this.finish()
      }
    })
  }

  release(): Promise<void> {
    if (this.stopped) return this.queue
    this.stop()
    return this.run(async () => {
      try {
        const db = this.keys.length > 0 ? await this.connect() : null
        if (!db) return
        const tx = db.transaction(STORE, 'readwrite')
        for (const key of this.keys) tx.objectStore(STORE).delete(key)
        await done(tx)
      } finally {
        this.finish()
      }
    })
  }
}

/** Starts keeping `doc` in this browser as a new copy: its whole state, then every update. */
export function keepCollabCopy(name: string, doc: Y.Doc): CollabCopy | null {
  if (!collabStashSupported()) return null
  return new Copy(name, doc, newCopyId(), null, [])
}

async function readRows(name: string): Promise<Array<{ key: IDBValidKey; row: Row }>> {
  const db = await openDatabase(name, () => undefined)
  try {
    const rows: Array<{ key: IDBValidKey; row: Row }> = []
    const tx = db.transaction(STORE, 'readonly')
    const cursor = tx.objectStore(STORE).openCursor()
    cursor.onsuccess = () => {
      const at = cursor.result
      if (!at) return
      const value: unknown = at.value
      // Records this module wrote; anything else in the store is skipped.
      if (
        value !== null &&
        typeof value === 'object' &&
        'copy' in value &&
        typeof value.copy === 'string' &&
        'update' in value &&
        value.update instanceof Uint8Array
      ) {
        rows.push({ key: at.primaryKey, row: { copy: value.copy, update: value.update } })
      }
      at.continue()
    }
    await done(tx)
    return rows
  } finally {
    db.close()
  }
}

/** Reads the claimed copies under their locks: each one a doc, empty ones released. */
async function openClaimed(name: string, claimed: Map<string, () => void>): Promise<CollabCopy[]> {
  try {
    // Read again under the locks: what a closing tab wrote last is in now.
    const groups = new Map<string, { keys: IDBValidKey[]; updates: Uint8Array[] }>()
    for (const { key, row } of await readRows(name)) {
      if (!claimed.has(row.copy)) continue
      const group = groups.get(row.copy) ?? { keys: [], updates: [] }
      group.keys.push(key)
      group.updates.push(row.update)
      groups.set(row.copy, group)
    }
    const copies: Array<{ copy: CollabCopy; last: IDBValidKey }> = []
    for (const [id, unlock] of claimed) {
      const group = groups.get(id)
      const doc = new Y.Doc()
      if (group) Y.transact(doc, () => group.updates.forEach((update) => Y.applyUpdate(doc, update)))
      const copy = new Copy(name, doc, id, unlock, group?.keys ?? [])
      if (doc.store.clients.size === 0) {
        // Nothing in it: not worth a restore.
        void copy.release().then(() => doc.destroy())
        continue
      }
      copies.push({ copy, last: group?.keys.at(-1) ?? 0 })
    }
    // Most recently written first: record keys only grow.
    return copies.sort((a, b) => indexedDB.cmp(b.last, a.last)).map(({ copy }) => copy)
  } catch (error) {
    for (const unlock of claimed.values()) unlock()
    throw error
  }
}

/** Where copies claimed after the first look go, until `signal` aborts. */
export interface LateCopies {
  signal: AbortSignal
  found: (copy: CollabCopy) => void
}

/** Waits until the tab holding a copy lets it go, then claims what is left of it. */
async function claimWhenFree(name: string, id: string, { signal, found }: LateCopies): Promise<void> {
  const unlock = await claim(`${name}#${id}`, signal)
  if (!unlock) return
  // A copy its owner sent or discarded is deleted before its lock goes: nothing found.
  for (const copy of await openClaimed(name, new Map([[id, unlock]]))) {
    if (signal.aborted) void copy.close().then(() => copy.doc.destroy())
    else found(copy)
  }
}

/**
 * Copies of `name` left by tabs that are gone (reloaded, closed, crashed),
 * now this tab's: each one is a doc of its own, the most recently written
 * first, and keeps being stored as it changes. Copies whose tab is still open
 * stay with that tab, which sends them itself. With `later`, this tab also
 * waits for those copies: when their tab goes away with something unsent, the
 * first open tab to get the lock claims the copy and hands it to `later.found`.
 */
export async function claimLeftoverCopies(name: string, later?: LateCopies): Promise<CollabCopy[]> {
  if (!collabStashSupported()) return []
  const ids = new Set((await readRows(name)).map(({ row }) => row.copy))
  const claimed = new Map<string, () => void>()
  for (const id of ids) {
    const unlock = await claim(`${name}#${id}`)
    if (unlock) claimed.set(id, unlock)
    else if (later) void claimWhenFree(name, id, later).catch(() => undefined)
  }
  return claimed.size === 0 ? [] : openClaimed(name, claimed)
}
