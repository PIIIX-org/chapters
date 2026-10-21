import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { locks } from 'node:worker_threads'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { RenderHookResult } from '@testing-library/react'
import * as Y from 'yjs'
import type * as CollabApi from '../api/collab.js'
import type { CollabSession } from './useCollabDoc.js'

/**
 * #720 across browser tabs. Each tab is its own module instance of the hook
 * and of everything it imports (`vi.resetModules`), so tabs share only what
 * tabs share in a browser: IndexedDB (fake-indexeddb), Web Locks (Node's,
 * since happy-dom has none) and BroadcastChannel. The tests use the hook
 * alone: copies in the store are made by tabs typing and closing, and what a
 * store holds is read back by opening the note in a new tab.
 *
 * The relay is a real `Y.Doc`; the provider is stubbed as in
 * `useCollabDoc.test.tsx`, and syncing is the Yjs state exchange done by hand.
 */
interface ProviderOptions {
  document: Y.Doc
  onStatus: (data: { status: string }) => void
  onSynced: (data: { state: boolean }) => void
  onUnsyncedChanges: (data: { number: number }) => void
}

interface StubProvider {
  options: ProviderOptions
  isSynced: boolean
  hasUnsyncedChanges: boolean
}

const stub = vi.hoisted(() => ({ providers: [] as StubProvider[], tickets: 0 }))

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
  getCollabTicket: () => {
    stub.tickets += 1
    return Promise.resolve({ token: `ticket-${stub.tickets}`, url: '/collab', expiresAt: '2026-08-25T10:00:60.000Z', maxNoteBytes: 1048576, maxFrameBytes: 6 * 1048576 + 65536 })
  },
}))

const USER = { id: 'u-taha', name: 'taha' }
const NOTE = { vaultId: 'v-1', noteId: 'n-1', path: 'journals/2026-08-25.md' }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const count = (text: string, needle: string) => text.split(needle).length - 1

interface Tab {
  view: RenderHookResult<CollabSession, unknown>
  provider: StubProvider
  now: () => CollabSession
}

/** Opens the note in a new tab: a fresh module instance, its own provider. */
async function newTab(): Promise<Tab> {
  vi.resetModules()
  // Imported per tab, not statically: each tab needs its own module instance.
  const { useCollabDoc } = await import('./useCollabDoc.js')
  const before = stub.providers.length
  const view = renderHook(() => useCollabDoc({ ...NOTE, user: USER, enabled: true }))
  await waitFor(() => expect(stub.providers.length).toBeGreaterThan(before))
  // Let the tab finish looking for copies left in the store.
  await act(() => sleep(50))
  return { view, provider: stub.providers[before]!, now: () => view.result.current }
}

/** The handshake: the relay's state arrives (origin: the provider), then the hook hears it. */
function sync(tab: Tab, relay: Y.Doc) {
  act(() => {
    tab.provider.options.onStatus({ status: 'connected' })
    const doc = tab.provider.options.document
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(relay, Y.encodeStateVector(doc)), tab.provider)
    tab.provider.isSynced = true
    tab.provider.options.onSynced({ state: true })
  })
}

/** What the provider sends: everything in its document the relay does not have. */
function push(tab: Tab, relay: Y.Doc) {
  Y.applyUpdate(relay, Y.encodeStateAsUpdate(tab.provider.options.document, Y.encodeStateVector(relay)))
}

function goOffline(tab: Tab) {
  tab.provider.hasUnsyncedChanges = true
  act(() => tab.provider.options.onStatus({ status: 'disconnected' }))
}

function type(tab: Tab, at: number, text: string) {
  act(() => tab.now().ydoc.getText('body').insert(at, text))
}

async function close(...tabs: Tab[]) {
  for (const tab of tabs) tab.view.unmount()
  // Closing writes the last keystrokes down.
  await act(() => sleep(100))
}

/**
 * The store holds a copy of the note's OLD document with text typed offline,
 * and the relay has since rebuilt the document from the note's text (purged
 * and re-created, or its CRDT state lost): same words, no shared history.
 */
async function unrelatedCopy(): Promise<Y.Doc> {
  const old = new Y.Doc()
  old.getText('body').insert(0, 'BASE line\n')
  const tab = await newTab()
  sync(tab, old)
  goOffline(tab)
  type(tab, 10, 'written offline\n')
  await close(tab)
  const relay = new Y.Doc()
  relay.getText('body').insert(0, 'BASE line\n')
  return relay
}

beforeAll(() => {
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
})

beforeEach(() => {
  stub.providers.length = 0
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
})

describe('useCollabDoc copies across tabs (#720)', () => {
  it('a discarded copy stays discarded while another tab is still waiting for the relay', async () => {
    const relay = await unrelatedCopy()
    const B = await newTab()
    sync(B, relay)
    const R = await newTab()
    act(() => B.now().discardUnmerged())
    expect(B.now().unmerged).toBeNull()
    await act(() => sleep(300))

    sync(R, relay)
    push(R, relay)
    expect(R.now().unmerged).toBeNull()
    expect(relay.getText('body').toString()).toBe('BASE line\n')
    await close(B, R)

    // A later visit finds nothing to offer again.
    const later = await newTab()
    sync(later, relay)
    expect(later.now().unmerged).toBeNull()
    expect(relay.getText('body').toString()).toBe('BASE line\n')
    await close(later)
  })

  it('the discarding tab storing its typing before a slow tab hears of the discard never duplicates the note', async () => {
    const relay = await unrelatedCopy()
    const B = await newTab()
    sync(B, relay)
    goOffline(B)
    type(B, 10, 'B-offline ')
    // Tab R is busy (a throttled background tab): whatever other tabs tell it
    // arrives late, so B stores its typing before R hears of the discard (the
    // order that put the note in twice on 51a807e; tabs no longer message each
    // other, the delay pins that order). R opens while the relay is unreachable.
    const Real = globalThis.BroadcastChannel
    class Slow extends Real {
      override set onmessage(handler: ((event: MessageEvent) => void) | null) {
        super.onmessage = handler && ((event: MessageEvent) => void setTimeout(() => handler.call(this, event), 50))
      }
      override get onmessage(): ((event: MessageEvent) => void) | null {
        return super.onmessage
      }
    }
    globalThis.BroadcastChannel = Slow
    let R: Tab
    try {
      R = await newTab()
    } finally {
      globalThis.BroadcastChannel = Real
    }
    act(() => R.provider.options.onStatus({ status: 'disconnected' }))

    act(() => B.now().discardUnmerged())
    await act(() => sleep(300))

    // R's relay comes back first, then B's.
    sync(R, relay)
    push(R, relay)
    sync(B, relay)
    push(B, relay)
    const text = relay.getText('body').toString()
    expect(count(text, 'BASE line')).toBe(1)
    expect(text).toBe('BASE line\nB-offline ')
    expect(R.now().unmerged).toBeNull()
    await close(B, R)
  })

  it('typing in a tab that shows the notice survives a reload', async () => {
    const relay = await unrelatedCopy()
    const A = await newTab()
    sync(A, relay)
    expect(A.now().unmerged).toBe('BASE line\nwritten offline\n')
    goOffline(A)
    type(A, 10, 'A-offline ')
    expect(A.now().unsynced).toBe(true)
    await close(A)

    const R = await newTab()
    expect(R.now().restored).toBe(true)
    sync(R, relay)
    push(R, relay)
    expect(relay.getText('body').toString()).toBe('BASE line\nA-offline ')
    // The old copy is still offered, not merged.
    expect(R.now().unmerged).toBe('BASE line\nwritten offline\n')
    await close(R)
  })

  it('a tab still open with unsent typing is not offered to another tab as left over', async () => {
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    // T never reached the relay; its typing has no history in common with it.
    const T = await newTab()
    act(() => T.provider.options.onStatus({ status: 'disconnected' }))
    type(T, 0, 'T-blank ')
    await act(() => sleep(100))

    const S = await newTab()
    expect(S.now().restored).toBe(false)
    sync(S, relay)
    expect(S.now().unmerged).toBeNull()
    goOffline(S)
    type(S, 10, 'S-offline ')
    await close(S)

    // S's offline typing was kept: a reload sends it.
    const again = await newTab()
    sync(again, relay)
    push(again, relay)
    expect(relay.getText('body').toString()).toBe('BASE line\nS-offline ')
    await close(again, T)
  })

  it('a keystroke into the restored copy just after it was merged reaches the relay', async () => {
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const first = await newTab()
    sync(first, relay)
    goOffline(first)
    type(first, 10, 'offline ')
    await close(first)

    const R = await newTab()
    expect(R.now().restored).toBe(true)
    // What the editor is bound to until the next render.
    const shown = R.now().ydoc
    sync(R, relay)
    expect(R.now().restored).toBe(false)
    act(() => shown.getText('body').insert(18, 'late '))
    R.provider.hasUnsyncedChanges = true
    push(R, relay)
    expect(relay.getText('body').toString()).toBe('BASE line\noffline late ')
    await close(R)
  })

  it('a tab already open restores the unsent typing of a tab that closes later, once (#766)', async () => {
    const relay = new Y.Doc()
    relay.getText('body').insert(0, 'BASE line\n')
    const A = await newTab()
    sync(A, relay)
    goOffline(A)
    type(A, 10, 'A-offline ')
    await act(() => sleep(100))

    // B and C open the note while A still holds its copy: not theirs to take.
    const B = await newTab()
    sync(B, relay)
    const C = await newTab()
    sync(C, relay)
    expect(B.now().ydoc.getText('body').toString()).toBe('BASE line\n')
    expect(C.now().ydoc.getText('body').toString()).toBe('BASE line\n')

    // A closes with the text unsent: an open tab picks it up, no reload.
    await close(A)
    const bodies = () => [B, C].map((tab) => tab.now().ydoc.getText('body').toString())
    await waitFor(() => expect(bodies()).toContain('BASE line\nA-offline '))
    await act(() => sleep(200))
    // One tab took it (the lock lets one at a time); the other found it gone.
    expect(bodies().filter((text) => text.includes('A-offline'))).toHaveLength(1)
    expect(B.now().unmerged).toBeNull()
    expect(C.now().unmerged).toBeNull()
    push(B, relay)
    push(C, relay)
    expect(relay.getText('body').toString()).toBe('BASE line\nA-offline ')
    await close(B, C)

    // Nothing left to offer or merge again.
    const later = await newTab()
    expect(later.now().restored).toBe(false)
    sync(later, relay)
    push(later, relay)
    expect(later.now().unmerged).toBeNull()
    expect(relay.getText('body').toString()).toBe('BASE line\nA-offline ')
    await close(later)
  })

  it('a copy with no history in common, left by a tab that closes later, is offered in the open tab (#766)', async () => {
    const relay = await unrelatedCopy()
    const A = await newTab()
    sync(A, relay)
    expect(A.now().unmerged).toBe('BASE line\nwritten offline\n')
    const B = await newTab()
    sync(B, relay)
    expect(B.now().unmerged).toBeNull()

    // A leaves without discarding it: B offers it, never merges it.
    await close(A)
    await waitFor(() => expect(B.now().unmerged).toBe('BASE line\nwritten offline\n'))
    push(B, relay)
    expect(relay.getText('body').toString()).toBe('BASE line\n')
    act(() => B.now().discardUnmerged())
    await close(B)

    const later = await newTab()
    sync(later, relay)
    expect(later.now().unmerged).toBeNull()
    await close(later)
  })
})
