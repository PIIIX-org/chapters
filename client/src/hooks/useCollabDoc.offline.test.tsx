import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import * as Y from 'yjs'
import { getCollabTicket } from '../api/collab.js'
import type * as CollabApi from '../api/collab.js'
import { claimLeftoverCopies, keepCollabCopy } from '../lib/collabStash.js'
import { clearCollabStashes, collabStashName, hasCollabStash } from '../lib/collabStashNames.js'
import { useCollabDoc } from './useCollabDoc.js'

/**
 * #720: what was typed while the socket was down lives in this browser's
 * IndexedDB (fake-indexeddb here), survives the hook and its provider being
 * re-created (a reload), and merges into the relay's document exactly once.
 *
 * The provider is stubbed at the module boundary like `useCollabDoc.test.tsx`
 * does; the relay is a real `Y.Doc`, and "syncing" is the same Yjs state
 * exchange the provider performs, done by hand: the relay's missing state is
 * applied with the provider as origin, and what the relay lacks is pushed back.
 */
interface ProviderOptions {
  name: string
  document: Y.Doc
  token: () => Promise<string>
  onStatus: (data: { status: string }) => void
  onSynced: (data: { state: boolean }) => void
  onUnsyncedChanges: (data: { number: number }) => void
}

type StubProvider = {
  options: ProviderOptions
  isSynced: boolean
  hasUnsyncedChanges: boolean
}

const stub = vi.hoisted(() => ({ providers: [] as StubProvider[] }))

vi.mock('@hocuspocus/provider', () => {
  class HocuspocusProvider {
    options: ProviderOptions
    awareness = { clientID: 7 }
    isSynced = false
    hasUnsyncedChanges = false
    constructor(options: ProviderOptions) {
      this.options = options
      stub.providers.push(this)
    }
    setAwarenessField() {}
    disconnect() {}
    destroy() {}
    flushPendingUpdates() {}
    on() {}
  }
  return {
    HocuspocusProvider,
    WebSocketStatus: { Connecting: 'connecting', Connected: 'connected', Disconnected: 'disconnected' },
  }
})

vi.mock('../api/collab.js', async (importOriginal) => ({
  ...(await importOriginal<typeof CollabApi>()),
  getCollabTicket: vi.fn(),
}))

const USER = { id: 'u-taha', name: 'taha' }
const NOTE = { vaultId: 'v-1', noteId: 'n-1', path: 'journals/2026-08-25.md' }
const STASH = collabStashName(USER.id, `${NOTE.vaultId}/~${NOTE.noteId}`)
/** The name a bundle before ADR-003 S2b kept this note's copies under: by path. */
const LEGACY_STASH = collabStashName(USER.id, `${NOTE.vaultId}/${NOTE.path}`)

function mount() {
  return renderHook(() => useCollabDoc({ ...NOTE, user: USER, enabled: true }))
}

async function nthProvider(n: number): Promise<StubProvider> {
  await waitFor(() => expect(stub.providers.length).toBeGreaterThan(n))
  return stub.providers[n]!
}

/** The handshake: the relay's state arrives (origin: the provider), then the hook hears it. */
function sync(provider: StubProvider, relay: Y.Doc) {
  act(() => {
    provider.options.onStatus({ status: 'connected' })
    const doc = provider.options.document
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(relay, Y.encodeStateVector(doc)), provider)
    provider.isSynced = true
    provider.options.onSynced({ state: true })
  })
}

/** What the provider sends: everything in its document the relay does not have. */
function push(provider: StubProvider, relay: Y.Doc) {
  Y.applyUpdate(relay, Y.encodeStateAsUpdate(provider.options.document, Y.encodeStateVector(relay)))
}

/**
 * The text of every copy stored for `name`, sorted, read straight from
 * IndexedDB: claiming them through the module would make them this tab's.
 */
async function stored(name: string): Promise<string[]> {
  const open = indexedDB.open(name)
  // Not there yet: abort instead of creating an empty database.
  open.onupgradeneeded = () => open.transaction?.abort()
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => resolve(null)
  })
  if (!db) return []
  try {
    if (!db.objectStoreNames.contains('updates')) return []
    const read = db.transaction('updates', 'readonly').objectStore('updates').getAll()
    const rows = await new Promise<Array<{ copy: string; update: Uint8Array }>>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result as Array<{ copy: string; update: Uint8Array }>)
      read.onerror = () => reject(read.error ?? new Error('read failed'))
    })
    const docs = new Map<string, Y.Doc>()
    for (const { copy, update } of rows) {
      const doc = docs.get(copy) ?? new Y.Doc()
      Y.applyUpdate(doc, update)
      docs.set(copy, doc)
    }
    return [...docs.values()].map((doc) => doc.getText('body').toString()).sort()
  } finally {
    db.close()
  }
}

/** Stores `text` as a copy left by a tab that is gone. */
async function seed(name: string, text: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, text)
  await keepCollabCopy(name, doc)!.close()
  return doc
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** The client's TS lib predates `Promise.withResolvers`. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  stub.providers.length = 0
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  let n = 0
  vi.mocked(getCollabTicket).mockImplementation(() => {
    n += 1
    return Promise.resolve({ token: `ticket-${n}`, url: '/collab', expiresAt: '2026-08-25T10:00:60.000Z', maxNoteBytes: 1048576, maxFrameBytes: 6 * 1048576 + 65536 })
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useCollabDoc offline copy (#720)', () => {
  it('restores text typed offline after the provider is re-created, and merges it once', async () => {
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')

    const first = mount()
    const p1 = await nthProvider(0)
    sync(p1, relay)
    // Typed while connected: the relay got it, but its acknowledgement never came back.
    act(() => first.result.current.ydoc.getText('body').insert(10, 'typed-online '))
    push(p1, relay)
    p1.hasUnsyncedChanges = true
    act(() => p1.options.onStatus({ status: 'disconnected' }))
    act(() => first.result.current.ydoc.getText('body').insert(23, 'typed-offline '))
    expect(first.result.current.status).toBe('reconnecting')
    expect(first.result.current.unsynced).toBe(true)
    first.unmount()

    await waitFor(async () => expect(await stored(STASH)).toEqual(['BASE line\ntyped-online typed-offline ']))

    // Someone else wrote while this browser was away.
    relay.getText('body').insert(relay.getText('body').length, 'AGENT line\n')

    // The reload: a new hook, a new provider, a new live document.
    const second = mount()
    await waitFor(() => expect(second.result.current.restored).toBe(true))
    // Shown before the relay answers: an unreachable relay must not hide it.
    expect(second.result.current.ydoc.getText('body').toString()).toBe('BASE line\ntyped-online typed-offline ')
    expect(second.result.current.unsynced).toBe(true)
    const p2 = await nthProvider(1)
    expect(second.result.current.ydoc).not.toBe(p2.options.document)

    sync(p2, relay)

    expect(second.result.current.restored).toBe(false)
    expect(second.result.current.ydoc).toBe(p2.options.document)
    const merged = second.result.current.ydoc.getText('body').toString()
    // The relay already held "typed-online": it must not come back twice.
    for (const part of ['BASE line', 'typed-online', 'typed-offline', 'AGENT line']) {
      expect(count(merged, part)).toBe(1)
    }
    expect(merged.length).toBe('BASE line\ntyped-online typed-offline AGENT line\n'.length)

    push(p2, relay)
    expect(relay.getText('body').toString()).toBe(merged)
    // The restored copy is gone; the live document's own copy holds the merge.
    await waitFor(async () => expect(await stored(STASH)).toEqual([merged]))
    second.unmount()
  })

  it('deletes the copy once the relay has acknowledged it', async () => {
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const view = mount()
    const provider = await nthProvider(0)
    sync(provider, relay)
    provider.hasUnsyncedChanges = true
    act(() => provider.options.onStatus({ status: 'disconnected' }))
    act(() => view.result.current.ydoc.getText('body').insert(10, 'offline '))
    await waitFor(async () => expect(await stored(STASH)).toEqual(['BASE line\noffline ']))

    // Back online: the relay takes the update and acknowledges it.
    sync(provider, relay)
    push(provider, relay)
    provider.hasUnsyncedChanges = false
    act(() => provider.options.onUnsyncedChanges({ number: 0 }))
    expect(view.result.current.unsynced).toBe(false)

    // Gone, so the next visit has nothing to restore.
    await waitFor(async () => expect(await stored(STASH)).toEqual([]), { timeout: 4000 })
    view.unmount()
  })

  it('does not merge a copy that shares no history with the relay, and offers its text instead', async () => {
    // The copy: a session on the note's old document, with text typed offline.
    await seed(STASH, 'BASE line\nwritten offline\n')
    // The relay rebuilt the document from the note's text (purged and
    // re-created, or its CRDT state lost): same words, no shared history.
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')

    const view = mount()
    await waitFor(() => expect(view.result.current.restored).toBe(true))
    const provider = await nthProvider(0)
    sync(provider, relay)

    // Merged, this would be "BASE line\nBASE line\nwritten offline\n".
    expect(view.result.current.ydoc).toBe(provider.options.document)
    expect(view.result.current.ydoc.getText('body').toString()).toBe('BASE line\n')
    expect(view.result.current.unmerged).toBe('BASE line\nwritten offline\n')
    push(provider, relay)
    expect(relay.getText('body').toString()).toBe('BASE line\n')
    // Kept until the person says otherwise.
    expect(await stored(STASH)).toEqual(['BASE line\nwritten offline\n'])

    act(() => view.result.current.discardUnmerged())
    expect(view.result.current.unmerged).toBeNull()
    await waitFor(async () => expect(await stored(STASH)).toEqual([]))
    view.unmount()
  })

  it('finds a copy kept under the path-keyed name of an older bundle and merges it once (ADR-003 §5.4)', async () => {
    // The relay's document, and a copy of it a tab on the old bundle kept with
    // typing the relay never got (refused with reload-required).
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const old = new Y.Doc()
    Y.applyUpdate(old, Y.encodeStateAsUpdate(relay))
    const copy = keepCollabCopy(LEGACY_STASH, old)!
    old.getText('body').insert(10, 'typed in the old tab\n')
    await copy.close()

    const view = mount()
    await waitFor(() => expect(view.result.current.restored).toBe(true))
    const provider = await nthProvider(0)
    expect(provider.options.name).toBe(`${NOTE.vaultId}/~${NOTE.noteId}`)
    sync(provider, relay)
    const merged = view.result.current.ydoc.getText('body').toString()
    expect(merged).toBe('BASE line\ntyped in the old tab\n')
    expect(view.result.current.unmerged).toBeNull()
    push(provider, relay)
    expect(relay.getText('body').toString()).toBe(merged)
    // The path-keyed copy is gone once the live document's own copy (id-keyed) holds it.
    await waitFor(async () => expect(await stored(LEGACY_STASH)).toEqual([]))
    await waitFor(async () => expect(await stored(STASH)).toEqual([merged]))
    view.unmount()
  })

  it('offers, not merges, a path-keyed copy that shares no history with the relay', async () => {
    await seed(LEGACY_STASH, 'BASE line\nfrom a re-seeded note\n')
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const view = mount()
    await waitFor(() => expect(view.result.current.restored).toBe(true))
    sync(await nthProvider(0), relay)
    expect(view.result.current.ydoc.getText('body').toString()).toBe('BASE line\n')
    expect(view.result.current.unmerged).toBe('BASE line\nfrom a re-seeded note\n')
    view.unmount()
  })

  it('one tab sending its copy never drops what another tab has not sent', async () => {
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const tabA = mount()
    const pA = await nthProvider(0)
    const tabB = mount()
    const pB = await nthProvider(1)
    sync(pA, relay)
    sync(pB, relay)

    for (const [tab, provider, text] of [
      [tabA, pA, 'from-A '],
      [tabB, pB, 'from-B '],
    ] as const) {
      provider.hasUnsyncedChanges = true
      act(() => provider.options.onStatus({ status: 'disconnected' }))
      act(() => tab.result.current.ydoc.getText('body').insert(10, text))
    }
    await waitFor(async () => expect(await stored(STASH)).toEqual(['BASE line\nfrom-A ', 'BASE line\nfrom-B ']))

    // Tab A gets through first: its copy goes, tab B's stays.
    sync(pA, relay)
    push(pA, relay)
    pA.hasUnsyncedChanges = false
    act(() => pA.options.onUnsyncedChanges({ number: 0 }))
    await waitFor(async () => expect(await stored(STASH)).toEqual(['BASE line\nfrom-B ']), { timeout: 4000 })
    tabA.unmount()
    tabB.unmount()
  })

  it('a discarded copy never comes back, and the note is never in twice (round-1 review)', async () => {
    await seed(STASH, 'BASE line\nwritten offline\n')
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const tabA = mount()
    await waitFor(() => expect(tabA.result.current.restored).toBe(true))
    const pA = await nthProvider(0)
    const tabB = mount()
    const pB = await nthProvider(1)
    sync(pA, relay)
    sync(pB, relay)
    // The copy is tab A's: tab B leaves it alone.
    expect(tabA.result.current.unmerged).toBe('BASE line\nwritten offline\n')
    expect(tabB.result.current.unmerged).toBeNull()

    act(() => tabA.result.current.discardUnmerged())
    pB.hasUnsyncedChanges = true
    act(() => tabB.result.current.ydoc.getText('body').insert(10, 'typed-in-B '))
    await waitFor(async () => expect(await stored(STASH)).toEqual(['BASE line\ntyped-in-B ']))
    push(pB, relay)

    expect(tabB.result.current.ydoc.getText('body').toString()).toBe('BASE line\ntyped-in-B ')
    expect(relay.getText('body').toString()).toBe('BASE line\ntyped-in-B ')
    tabA.unmount()
    tabB.unmount()
  })

  it('a copy without shared history stored after a tab looked never reaches its live document', async () => {
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const view = mount()
    const provider = await nthProvider(0)
    sync(provider, relay)
    expect(view.result.current.restored).toBe(false)
    await seed(STASH, 'BASE line\nwritten offline\n')

    provider.hasUnsyncedChanges = true
    act(() => view.result.current.ydoc.getText('body').insert(10, 'typed '))
    await waitFor(async () => expect(await stored(STASH)).toEqual(['BASE line\ntyped ', 'BASE line\nwritten offline\n']))
    push(provider, relay)

    expect(view.result.current.ydoc.getText('body').toString()).toBe('BASE line\ntyped ')
    expect(relay.getText('body').toString()).toBe('BASE line\ntyped ')
    view.unmount()
  })

  it('a restored copy says Offline, not Connecting, while the relay refuses the socket', async () => {
    await seed(STASH, 'BASE line\nwritten offline\n')

    const view = mount()
    const provider = await nthProvider(0)
    // The provider retries: every attempt is "connecting", then "disconnected".
    act(() => provider.options.onStatus({ status: 'connecting' }))
    act(() => provider.options.onStatus({ status: 'disconnected' }))
    act(() => provider.options.onStatus({ status: 'connecting' }))
    await waitFor(() => expect(view.result.current.restored).toBe(true))
    expect(view.result.current.status).toBe('reconnecting')
    expect(view.result.current.unsynced).toBe(true)
    view.unmount()
  })

  it('keeps a restored copy when the live copy cannot store the merge (#765)', async () => {
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const typed = new Y.Doc()
    Y.applyUpdate(typed, Y.encodeStateAsUpdate(relay))
    typed.getText('body').insert(10, 'typed offline ')
    await keepCollabCopy(STASH, typed)!.close()

    // Storage is full from here on: every new record is refused.
    const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })
    try {
      const first = mount()
      await waitFor(() => expect(first.result.current.restored).toBe(true))
      const p1 = await nthProvider(0)
      // Merged, but the relay never acknowledges it.
      p1.hasUnsyncedChanges = true
      sync(p1, relay)
      expect(first.result.current.ydoc.getText('body').toString()).toBe('BASE line\ntyped offline ')
      expect(first.result.current.unsynced).toBe(true)
      // Let the merge's write fail and the copy be closed or released.
      await pause(100)
      first.unmount()
      await pause(100)

      expect(await stored(STASH)).toEqual(['BASE line\ntyped offline '])
      // The reload offers it again.
      const second = mount()
      await waitFor(() => expect(second.result.current.restored).toBe(true))
      expect(second.result.current.ydoc.getText('body').toString()).toBe('BASE line\ntyped offline ')
      second.unmount()
    } finally {
      add.mockRestore()
    }
  })
})

describe('collab copies in IndexedDB (#720)', () => {
  it('keeps unrelated documents apart in one store, also past compaction', async () => {
    const before = new Y.Doc()
    const after = new Y.Doc()
    const copies = [keepCollabCopy(STASH, before)!, keepCollabCopy(STASH, after)!]
    // Interleaved, one record per keystroke, past the 500 records a copy is
    // rewritten at.
    for (let i = 0; i < 600; i++) {
      before.getText('body').insert(before.getText('body').length, 'o')
      after.getText('body').insert(after.getText('body').length, 'n')
      await Promise.all(copies.map((copy) => copy.flushed()))
    }
    await Promise.all(copies.map((copy) => copy.close()))
    const db = await new Promise<IDBDatabase>((resolve) => {
      const open = indexedDB.open(STASH)
      open.onsuccess = () => resolve(open.result)
    })
    const records = await new Promise<number>((resolve) => {
      const counting = db.transaction('updates', 'readonly').objectStore('updates').count()
      counting.onsuccess = () => resolve(counting.result)
    })
    db.close()
    // Rewritten whole at the 501st keystroke: 1 + 99 records per copy, not 600.
    expect(records).toBe(2 * 100)

    const left = await claimLeftoverCopies(STASH)
    expect(left.map((copy) => copy.doc.getText('body').toString()).sort()).toEqual(['n'.repeat(600), 'o'.repeat(600)])
    // Each one written by its own document only.
    expect(left.map((copy) => copy.doc.store.clients.size)).toEqual([1, 1])
    await Promise.all(left.map((copy) => copy.close()))
  })

  it('without Web Locks, a copy taken by another tab while still open is stored whole again', async () => {
    expect(navigator.locks ?? null).toBeNull()
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'BASE line\n')
    const open = keepCollabCopy(STASH, doc)!
    await open.flushed()

    // Another tab cannot tell the copy is open: it takes it, merges it and deletes it.
    vi.resetModules()
    // Its own module instance, as another tab has.
    const other = await import('../lib/collabStash.js')
    const taken = await other.claimLeftoverCopies(STASH)
    expect(taken).toHaveLength(1)
    await taken[0]!.release()
    expect(await stored(STASH)).toEqual([])

    // The open tab keeps typing: what it stores next is the whole document.
    doc.getText('body').insert(10, 'more ')
    await open.close()
    expect(await stored(STASH)).toEqual(['BASE line\nmore '])
  })

  it('logout deletes that user\'s copies and nobody else\'s', async () => {
    const other = collabStashName('u-jane', `${NOTE.vaultId}/~${NOTE.noteId}`)
    for (const name of [STASH, other]) await seed(name, `kept for ${name}`)

    await clearCollabStashes(USER.id)

    const names = (await indexedDB.databases()).map((db) => db.name)
    expect(names).not.toContain(STASH)
    expect(names).toContain(other)
    expect(await stored(other)).toEqual([`kept for ${other}`])
  })

  it('a copy still open when its user logs out stops writing instead of re-creating the store', async () => {
    const doc = new Y.Doc()
    const copy = keepCollabCopy(STASH, doc)!
    doc.getText('body').insert(0, 'typed before logout')
    await copy.flushed()

    await clearCollabStashes(USER.id)
    doc.getText('body').insert(0, 'typed after logout ')
    await copy.close()

    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain(STASH)
  })

  it('finds the copies without indexedDB.databases() (Firefox < 126)', async () => {
    const other = collabStashName('u-jane', `${NOTE.vaultId}/~${NOTE.noteId}`)
    for (const name of [STASH, other]) await seed(name, `kept for ${name}`)
    const databases = indexedDB.databases.bind(indexedDB)
    Object.defineProperty(indexedDB, 'databases', { value: undefined, configurable: true })
    try {
      // A note never kept here is not opened (which would create a database).
      expect(await hasCollabStash(collabStashName(USER.id, 'v-1/never-opened.md'))).toBe(false)
      expect(await hasCollabStash(STASH)).toBe(true)
      await clearCollabStashes(USER.id)
      expect(await hasCollabStash(STASH)).toBe(false)
    } finally {
      Object.defineProperty(indexedDB, 'databases', { value: databases, configurable: true })
    }
    const names = (await indexedDB.databases()).map((db) => db.name)
    expect(names).not.toContain(STASH)
    expect(names).toContain(other)
  })
})
