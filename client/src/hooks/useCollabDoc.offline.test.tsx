import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import * as Y from 'yjs'
import { getCollabTicket } from '../api/collab.js'
import type * as CollabApi from '../api/collab.js'
import {
  clearCollabStashes,
  closeCollabStash,
  collabStashName,
  hasCollabStash,
  openCollabStash,
} from '../lib/collabStash.js'
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
const NOTE = { vaultId: 'v-1', path: 'journals/2026-08-25.md' }
const STASH = collabStashName(USER.id, `${NOTE.vaultId}/${NOTE.path}`)

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
 * What is stored for `name`, read straight from IndexedDB: a handle of the
 * module's own would count as one more open copy and be rewritten.
 */
async function readStore(name: string): Promise<{ text: string; records: number }> {
  const open = indexedDB.open(name)
  // Not there yet: abort instead of creating an empty database y-indexeddb
  // would then open without its stores.
  open.onupgradeneeded = () => open.transaction?.abort()
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => resolve(null)
  })
  if (!db) return { text: '', records: 0 }
  try {
    if (!db.objectStoreNames.contains('updates')) return { text: '', records: 0 }
    const read = db.transaction('updates', 'readonly').objectStore('updates').getAll()
    const updates = await new Promise<Uint8Array[]>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result as Uint8Array[])
      read.onerror = () => reject(read.error ?? new Error('read failed'))
    })
    const doc = new Y.Doc()
    for (const update of updates) Y.applyUpdate(doc, update)
    return { text: doc.getText('body').toString(), records: updates.length }
  } finally {
    db.close()
  }
}

async function stored(name: string): Promise<string> {
  return (await readStore(name)).text
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

beforeEach(() => {
  stub.providers.length = 0
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  let n = 0
  vi.mocked(getCollabTicket).mockImplementation(() => {
    n += 1
    return Promise.resolve({ token: `ticket-${n}`, url: '/collab', expiresAt: '2026-08-25T10:00:60.000Z' })
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

    await waitFor(async () => expect(await stored(STASH)).toBe('BASE line\ntyped-online typed-offline '))

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
    second.unmount()
  })

  it('empties the copy once the relay has acknowledged it', async () => {
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const view = mount()
    const provider = await nthProvider(0)
    sync(provider, relay)
    provider.hasUnsyncedChanges = true
    act(() => provider.options.onStatus({ status: 'disconnected' }))
    act(() => view.result.current.ydoc.getText('body').insert(10, 'offline '))
    await waitFor(async () => expect(await stored(STASH)).toBe('BASE line\noffline '))

    // Back online: the relay takes the update and acknowledges it.
    sync(provider, relay)
    push(provider, relay)
    provider.hasUnsyncedChanges = false
    act(() => provider.options.onUnsyncedChanges({ number: 0 }))
    expect(view.result.current.unsynced).toBe(false)

    // Emptied, so the next visit has nothing to restore.
    await waitFor(async () => expect(await readStore(STASH)).toEqual({ text: '', records: 0 }), {
      timeout: 4000,
    })
    view.unmount()
  })

  it('does not merge a copy that shares no history with the relay, and offers its text instead', async () => {
    // The copy: a session on the note's old document, with text typed offline.
    const old = new Y.Doc()
    old.getText('body').insert(0, 'BASE line\nwritten offline\n')
    const stash = openCollabStash(STASH, old)!
    await stash.loaded
    await closeCollabStash(stash)
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
    expect(await stored(STASH)).toBe('BASE line\nwritten offline\n')

    act(() => view.result.current.discardUnmerged())
    expect(view.result.current.unmerged).toBeNull()
    await waitFor(async () => expect(await stored(STASH)).toBe(''))
    view.unmount()
  })

  it('one tab emptying the copy never drops what another tab has not sent', async () => {
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
    await waitFor(async () => expect(await stored(STASH)).toContain('from-B'))

    expect((await readStore(STASH)).records).toBeGreaterThan(1)

    // Tab A gets through first and empties the shared store.
    sync(pA, relay)
    push(pA, relay)
    pA.hasUnsyncedChanges = false
    act(() => pA.options.onUnsyncedChanges({ number: 0 }))
    // Emptied, then tab B wrote its whole document back as one record.
    await waitFor(async () => expect((await readStore(STASH)).records).toBe(1), { timeout: 4000 })

    // Tab B is still cut off; its text is still in this browser.
    expect(await stored(STASH)).toContain('from-B')
    tabA.unmount()
    tabB.unmount()
  })

  /** The copy left by a session on the note's old document; the relay rebuilt it from the text. */
  async function unrelatedCopy(): Promise<Y.Doc> {
    const old = new Y.Doc()
    old.getText('body').insert(0, 'BASE line\nwritten offline\n')
    const stash = openCollabStash(STASH, old)!
    await stash.loaded
    await closeCollabStash(stash)
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    return relay
  }

  it('two tabs show the notice: discarding in one and typing in the other never duplicates the note', async () => {
    const relay = await unrelatedCopy()
    const tabA = mount()
    await waitFor(() => expect(tabA.result.current.restored).toBe(true))
    const pA = await nthProvider(0)
    const tabB = mount()
    await waitFor(() => expect(tabB.result.current.restored).toBe(true))
    const pB = await nthProvider(1)
    sync(pA, relay)
    sync(pB, relay)
    expect(tabA.result.current.unmerged).toBe('BASE line\nwritten offline\n')
    expect(tabB.result.current.unmerged).toBe('BASE line\nwritten offline\n')

    // B discards the copy, then types.
    act(() => tabB.result.current.discardUnmerged())
    pB.hasUnsyncedChanges = true
    act(() => tabB.result.current.ydoc.getText('body').insert(10, 'typed-in-B '))
    await waitFor(async () => expect(await stored(STASH)).toContain('typed-in-B'))
    push(pB, relay)

    // Had the copy reached B's live document, this would be the note twice:
    // "BASE line\nwritten offline\nBASE line\ntyped-in-B ".
    expect(tabB.result.current.ydoc.getText('body').toString()).toBe('BASE line\ntyped-in-B ')
    expect(relay.getText('body').toString()).toBe('BASE line\ntyped-in-B ')
    // No tab put the discarded copy back, and the other tab stopped offering it.
    expect(await stored(STASH)).toBe('BASE line\ntyped-in-B ')
    await waitFor(() => expect(tabA.result.current.unmerged).toBeNull())
    tabA.unmount()
    tabB.unmount()
  })

  it('never loads a copy without shared history into the live document when it starts keeping one', async () => {
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const view = mount()
    const provider = await nthProvider(0)
    sync(provider, relay)
    expect(view.result.current.restored).toBe(false)
    // The store gets a copy of the note's old document after this tab looked.
    const old = new Y.Doc()
    old.getText('body').insert(0, 'BASE line\nwritten offline\n')
    const stash = openCollabStash(STASH, old)!
    await stash.loaded
    await closeCollabStash(stash)

    provider.hasUnsyncedChanges = true
    act(() => view.result.current.ydoc.getText('body').insert(10, 'typed '))
    await waitFor(() => expect(view.result.current.unmerged).toBe('BASE line\nwritten offline\n'))
    push(provider, relay)

    expect(view.result.current.ydoc.getText('body').toString()).toBe('BASE line\ntyped ')
    expect(relay.getText('body').toString()).toBe('BASE line\ntyped ')
    // The old copy stays as it was until the person discards it.
    expect(await stored(STASH)).toBe('BASE line\nwritten offline\n')

    act(() => view.result.current.discardUnmerged())
    // Then the live document is kept, on its own.
    await waitFor(async () => expect(await stored(STASH)).toBe('BASE line\ntyped '))
    view.unmount()
  })

  it('a restored copy says Offline, not Connecting, while the relay refuses the socket', async () => {
    const old = new Y.Doc()
    old.getText('body').insert(0, 'BASE line\nwritten offline\n')
    const stash = openCollabStash(STASH, old)!
    await stash.loaded
    await closeCollabStash(stash)

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

  it('finds the copies without indexedDB.databases() (Firefox < 126)', async () => {
    const other = collabStashName('u-jane', `${NOTE.vaultId}/${NOTE.path}`)
    for (const name of [STASH, other]) {
      const doc = new Y.Doc()
      doc.getText('body').insert(0, `kept for ${name}`)
      const stash = openCollabStash(name, doc)!
      await stash.loaded
      await closeCollabStash(stash)
    }
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

  it('logout deletes that user\'s copies and nobody else\'s', async () => {
    const other = collabStashName('u-jane', `${NOTE.vaultId}/${NOTE.path}`)
    for (const name of [STASH, other]) {
      const doc = new Y.Doc()
      doc.getText('body').insert(0, `kept for ${name}`)
      const stash = openCollabStash(name, doc)!
      await stash.loaded
      await closeCollabStash(stash)
    }

    await clearCollabStashes(USER.id)

    const names = (await indexedDB.databases()).map((db) => db.name)
    expect(names).not.toContain(STASH)
    expect(names).toContain(other)
    expect(await stored(other)).toBe(`kept for ${other}`)
  })
})
