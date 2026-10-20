import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import * as Y from 'yjs'
import { getCollabTicket } from '../api/collab.js'
import { ApiError } from '../lib/api.js'
import { AI_INK, inkFor } from '../lib/ink.js'
import { useCollabDoc } from './useCollabDoc.js'

/** The subset of the provider's configuration this hook actually passes. */
interface ProviderOptions {
  url: string
  name: string
  document: unknown
  token: () => Promise<string>
  onStatus: (data: { status: string }) => void
  onAuthenticationFailed: (data: { reason: string }) => void
  onClose: (data: { event: { code: number; reason: string } }) => void
  onSynced: (data: { state: boolean }) => void
  onUnsyncedChanges: (data: { number: number }) => void
  onAwarenessChange: (data: {
    states: { clientId: number; user?: { id: string; name: string }; agent?: { name?: string; activity?: string } }[]
  }) => void
}

/**
 * The provider is stubbed at the module boundary, as the plan requires: a
 * hand-rolled websocket would test happy-dom, not this hook. Every option the
 * hook passes is captured so the tests can drive the real callbacks.
 */
const stub = vi.hoisted(() => ({
  providers: [] as {
    options: ProviderOptions
    awareness: { clientID: number }
    isSynced: boolean
    hasUnsyncedChanges: boolean
    awarenessFields: Record<string, unknown>
    disconnected: boolean
    reconnects: number
    destroyed: boolean
    flushedPendingUpdates: boolean
    listeners: Map<string, ((...args: unknown[]) => void)[]>
    emit: (event: string, ...args: unknown[]) => void
  }[],
}))

vi.mock('@hocuspocus/provider', () => {
  class HocuspocusProvider {
    options: ProviderOptions
    awareness = { clientID: 7 }
    isSynced = false
    hasUnsyncedChanges = false
    awarenessFields: Record<string, unknown> = {}
    disconnected = false
    reconnects = 0
    destroyed = false
    flushedPendingUpdates = false
    listeners = new Map<string, ((...args: unknown[]) => void)[]>()

    constructor(options: ProviderOptions) {
      this.options = options
      stub.providers.push(this)
    }

    setAwarenessField(field: string, value: unknown) {
      this.awarenessFields[field] = value
    }

    disconnect() {
      this.disconnected = true
    }

    connect() {
      this.disconnected = false
      this.reconnects += 1
    }

    destroy() {
      this.destroyed = true
    }

    flushPendingUpdates() {
      this.flushedPendingUpdates = true
    }

    on(event: string, fn: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? []
      list.push(fn)
      this.listeners.set(event, list)
    }

    emit(event: string, ...args: unknown[]) {
      for (const fn of this.listeners.get(event) ?? []) {
        fn(...args)
      }
    }
  }

  return {
    HocuspocusProvider,
    WebSocketStatus: { Connecting: 'connecting', Connected: 'connected', Disconnected: 'disconnected' },
  }
})

vi.mock('../api/collab.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/collab.js')>()),
  getCollabTicket: vi.fn(),
}))

const ticket = vi.mocked(getCollabTicket)

function ticketNamed(token: string) {
  return { token, url: 'ws://relay.test:3001', expiresAt: '2026-08-25T10:00:60.000Z', maxNoteBytes: 1048576, maxFrameBytes: 6 * 1048576 + 65536 }
}

function mount(overrides: Partial<Parameters<typeof useCollabDoc>[0]> = {}) {
  return renderHook(() =>
    useCollabDoc({
      vaultId: 'v-1',
      path: 'journals/2026-08-25.md',
      user: { id: 'u-taha', name: 'taha' },
      enabled: true,
      ...overrides,
    }),
  )
}

/** Waits for the ticket fetch to resolve and the provider to be constructed. */
async function connected() {
  const view = mount()
  await waitFor(() => expect(stub.providers).toHaveLength(1))
  return { view, provider: stub.providers[0]! }
}

beforeEach(() => {
  stub.providers.length = 0
  let n = 0
  ticket.mockImplementation(() => {
    n += 1
    return Promise.resolve(ticketNamed(`ticket-${n}`))
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useCollabDoc', () => {
  it('joins the note document at the URL the ticket names', async () => {
    const { view, provider } = await connected()

    expect(provider.options.url).toBe('ws://relay.test:3001')
    expect(provider.options.name).toBe('v-1/journals/2026-08-25.md')
    expect(provider.options.document).toBe(view.result.current.ydoc)
    expect(view.result.current.writable).toBe(true)
    await waitFor(() => expect(view.result.current.awareness).toBe(provider.awareness))
  })

  it('spends the ticket it already holds, then mints a fresh one per reconnect', async () => {
    const { provider } = await connected()

    // Tickets are single-use; the first is already paid for by the handshake.
    await expect(provider.options.token()).resolves.toBe('ticket-1')
    expect(ticket).toHaveBeenCalledTimes(1)

    await expect(provider.options.token()).resolves.toBe('ticket-2')
    expect(ticket).toHaveBeenCalledTimes(2)
  })

  it('reports connecting, then connected, then reconnecting after a drop', async () => {
    const { view, provider } = await connected()
    expect(view.result.current.status).toBe('connecting')

    act(() => provider.options.onStatus({ status: 'connected' }))
    expect(view.result.current.status).toBe('connected')

    act(() => provider.options.onStatus({ status: 'disconnected' }))
    expect(view.result.current.status).toBe('reconnecting')
  })

  it('a drop before the first handshake is still connecting, not reconnecting', async () => {
    const { view, provider } = await connected()

    act(() => provider.options.onStatus({ status: 'disconnected' }))

    expect(view.result.current.status).toBe('connecting')
  })

  it('being kicked stops the retry loop and keeps the unsent text on screen', async () => {
    const { view, provider } = await connected()
    act(() => provider.options.onStatus({ status: 'connected' }))
    act(() => {
      view.result.current.ydoc.getText('body').insert(0, 'a sentence nobody else has seen')
    })

    // The share is revoked: the relay refuses the reconnect's fresh ticket.
    act(() => provider.options.onAuthenticationFailed({ reason: 'permission-denied' }))

    expect(view.result.current.status).toBe('revoked')
    expect(provider.disconnected).toBe(true)
    // The one thing a kick must never do.
    expect(view.result.current.ydoc.getText('body').toString()).toBe(
      'a sentence nobody else has seen',
    )
    expect(view.result.current.ydoc.isDestroyed).toBe(false)
  })

  describe('a session that ended (#498)', () => {
    it('the relay closing with signed-out stops the editor and keeps the text on screen', async () => {
      const { view, provider } = await connected()
      act(() => provider.options.onStatus({ status: 'connected' }))
      act(() => {
        view.result.current.ydoc.getText('body').insert(0, 'typed just before logout')
      })

      // Logout here or in another tab of the session: the relay closes the document.
      act(() => provider.options.onClose({ event: { code: 1000, reason: 'signed-out' } }))

      expect(view.result.current.status).toBe('signed-out')
      expect(view.result.current.writable).toBe(false)
      expect(provider.disconnected).toBe(true)
      expect(view.result.current.ydoc.getText('body').toString()).toBe('typed just before logout')
      // The refused reconnect that follows does not turn it into a revocation.
      act(() => provider.options.onAuthenticationFailed({ reason: 'permission-denied' }))
      act(() => provider.options.onStatus({ status: 'connected' }))
      expect(view.result.current.status).toBe('signed-out')
    })

    it('a ticket refused with 401 is signed out: no provider, no retry under a later session', async () => {
      ticket.mockRejectedValue(new ApiError(401, { error: 'authentication required' }))
      const view = mount()

      await waitFor(() => expect(view.result.current.status).toBe('signed-out'))
      expect(view.result.current.writable).toBe(false)
      expect(stub.providers).toHaveLength(0)
      expect(ticket).toHaveBeenCalledTimes(1)
    })

    it('a reconnect ticket refused with 401 is signed out, not revoked', async () => {
      const { view, provider } = await connected()
      act(() => provider.options.onStatus({ status: 'connected' }))
      await provider.options.token()
      ticket.mockRejectedValue(new ApiError(401, { error: 'authentication required' }))

      await act(async () => {
        await expect(provider.options.token()).rejects.toBeInstanceOf(ApiError)
      })

      expect(view.result.current.status).toBe('signed-out')
      expect(view.result.current.writable).toBe(false)
      expect(provider.disconnected).toBe(true)
    })
  })

  it('stays revoked when the socket reports itself back up', async () => {
    const { view, provider } = await connected()
    act(() => provider.options.onAuthenticationFailed({ reason: 'permission-denied' }))

    // A late status event from the socket teardown must not read as recovery.
    act(() => provider.options.onStatus({ status: 'connected' }))

    expect(view.result.current.status).toBe('revoked')
  })

  describe('a change the relay refuses as too large (#491)', () => {
    const LIMIT = 1048576

    /** Connected, with a local paste that takes the body `over` bytes past the cap. */
    async function overTheCap(over: number) {
      const { view, provider } = await connected()
      act(() => provider.options.onStatus({ status: 'connected' }))
      act(() => {
        // Two bytes a character: the cap is in UTF-8 bytes, not characters.
        view.result.current.ydoc.getText('body').insert(0, 'é'.repeat(LIMIT / 2) + 'x'.repeat(over))
      })
      return { view, provider }
    }

    it('stops reconnecting, keeps the text writable on screen and says how much to cut', async () => {
      const { view, provider } = await overTheCap(10)

      act(() => provider.options.onClose({ event: { code: 1000, reason: 'note-too-large' } }))

      expect(view.result.current.status).toBe('too-large')
      expect(provider.disconnected).toBe(true)
      expect(view.result.current.tooLarge).toEqual({ limitBytes: LIMIT, bodyBytes: LIMIT + 10 })
      // Writable, so the person can cut it down; nothing is dropped.
      expect(view.result.current.writable).toBe(true)
      expect(view.result.current.unsynced).toBe(true)
      expect(view.result.current.ydoc.getText('body').length).toBe(LIMIT / 2 + 10)

      // The socket teardown that follows is not a reconnect.
      act(() => provider.options.onStatus({ status: 'disconnected' }))
      expect(view.result.current.status).toBe('too-large')
    })

    it('reconnects by itself once the note fits again, not before', async () => {
      const { view, provider } = await overTheCap(10)
      act(() => provider.options.onClose({ event: { code: 1000, reason: 'note-too-large' } }))

      act(() => view.result.current.ydoc.getText('body').delete(0, 2))
      expect(view.result.current.tooLarge).toEqual({ limitBytes: LIMIT, bodyBytes: LIMIT + 6 })
      expect(provider.reconnects).toBe(0)

      const ydoc = view.result.current.ydoc
      act(() => ydoc.getText('body').delete(0, 3))
      expect(view.result.current.tooLarge).toBeNull()
      expect(view.result.current.status).toBe('reconnecting')
      // A new provider on the same document: its sync sends everything in one
      // update, not the old one's queue of single keystrokes.
      expect(provider.destroyed).toBe(true)
      await waitFor(() => expect(stub.providers).toHaveLength(2))
      const next = stub.providers[1]!
      expect(next.options.document).toBe(ydoc)
      expect(view.result.current.ydoc).toBe(ydoc)

      act(() => next.options.onStatus({ status: 'connected' }))
      expect(view.result.current.status).toBe('connected')
    })

    it('a refused paste that was undone is not sent again: the document is rebuilt from what is on screen', async () => {
      const { view, provider } = await connected()
      act(() => provider.options.onStatus({ status: 'connected' }))
      act(() => provider.options.onSynced({ state: true }))
      const first = view.result.current.ydoc
      act(() => first.getText('body').insert(0, 'kept text'))
      // The editor's undo history keeps deleted text in the document.
      const undo = new Y.UndoManager(first.getText('body'))
      act(() => first.getText('body').insert(0, 'x'.repeat(7 * LIMIT)))
      act(() => provider.options.onClose({ event: { code: 1009, reason: '' } }))
      expect(view.result.current.status).toBe('too-large')

      act(() => {
        undo.undo()
      })
      // What a reconnect would send still holds the whole paste, over the relay's frame limit.
      expect(Y.encodeStateAsUpdate(first).length).toBeGreaterThan(7 * LIMIT)
      expect(provider.reconnects).toBe(0)
      await waitFor(() => expect(view.result.current.ydoc).not.toBe(first))
      const rebuilt = view.result.current.ydoc
      expect(rebuilt.getText('body').toString()).toBe('kept text')
      expect(Y.encodeStateAsUpdate(rebuilt).length).toBeLessThan(1024)
      // Same history as the relay's document, so it merges instead of duplicating.
      expect([...rebuilt.store.clients.keys()]).toEqual([...first.store.clients.keys()])
      expect(view.result.current.tooLarge).toBeNull()
      expect(view.result.current.unsynced).toBe(true)
      await waitFor(() => expect(stub.providers).toHaveLength(2))
      expect(stub.providers[1]!.options.document).toBe(rebuilt)
      expect(view.result.current.status).toBe('reconnecting')
    })

    it('a frame the relay closed for its size (1009) is the same refusal', async () => {
      const { view, provider } = await overTheCap(5)

      act(() => provider.options.onClose({ event: { code: 1009, reason: '' } }))

      expect(view.result.current.status).toBe('too-large')
      expect(provider.disconnected).toBe(true)
    })

    it('any other close is not', async () => {
      const { view, provider } = await overTheCap(5)

      act(() => provider.options.onClose({ event: { code: 1000, reason: 'provider_initiated' } }))

      expect(view.result.current.status).toBe('connected')
      expect(view.result.current.tooLarge).toBeNull()
    })
  })

  it('broadcasts the local identity in its own hashed ink', async () => {
    const { provider } = await connected()

    // Through inkFor, not literal hexes: the palette is one source of truth,
    // and a copy of it here goes stale the moment a hue is adjusted — which is
    // exactly what happened when the inks were fixed for dark-mode contrast.
    const mine = inkFor('u-taha')
    expect(provider.awarenessFields.user).toEqual({
      id: 'u-taha',
      name: 'taha',
      color: mine.color,
      colorLight: mine.colorLight,
    })
    // Fixture guard: a palette that collapsed to one hue would pass the above.
    expect(mine.color).not.toBe(inkFor('u-jane').color)
  })

  it('lists peers in per-user inks, and never itself', async () => {
    const { view, provider } = await connected()

    act(() =>
      provider.options.onAwarenessChange({
        states: [
          { clientId: 7, user: { id: 'u-taha', name: 'taha' } },
          { clientId: 11, user: { id: 'u-jane', name: 'jane' } },
          { clientId: 12, user: { id: 'u-omar', name: 'omar' } },
          { clientId: 13, user: { id: 'mcp', name: 'Chapters MCP' } },
          // Connected, but hasn't published who it is yet.
          { clientId: 14 },
        ],
      }),
    )

    expect(view.result.current.peers).toEqual([
      {
        kind: 'person',
        clientId: 11,
        userId: 'u-jane',
        name: 'jane',
        ink: inkFor('u-jane'),
      },
      {
        kind: 'person',
        clientId: 12,
        userId: 'u-omar',
        name: 'omar',
        ink: inkFor('u-omar'),
      },
      {
        kind: 'person',
        clientId: 13,
        userId: 'mcp',
        name: 'Chapters MCP',
        // A human ink, not teal: see below.
        ink: inkFor('mcp'),
      },
    ])
  })

  it('gives teal to no person, because awareness ids are self-declared', async () => {
    const { view, provider } = await connected()

    act(() =>
      provider.options.onAwarenessChange({
        // A human on a patched client, broadcasting the AI's id. A `user` is
        // the peer's own claim about itself, so it stays a person.
        states: [{ clientId: 21, user: { id: 'mcp', name: 'Chapters MCP' } }],
      }),
    )

    const impostor = view.result.current.peers[0]!
    expect(impostor.kind).toBe('person')
    expect(impostor.ink.color).not.toBe(AI_INK.color)
    expect(impostor.ink.name).not.toBe('teal')
    // ...and the ink is still the hash of the id it claimed, not a fixed hue:
    // dropping teal must not collapse everyone onto one colour.
    expect(impostor.ink).toEqual(inkFor('mcp'))
    expect(inkFor('mcp').color).not.toBe(inkFor('u-jane').color) // fixture guard
  })

  it('lists an agent the relay put in presence as an agent, in teal (#481)', async () => {
    const { view, provider } = await connected()

    act(() =>
      provider.options.onAwarenessChange({
        // Only the relay sends `agent` (it strips the field from every
        // browser's state), under a client id of its own.
        states: [
          { clientId: 11, user: { id: 'u-jane', name: 'jane' } },
          { clientId: 31, agent: { name: 'Claude Code', activity: 'editing' } },
          { clientId: 32, agent: { name: 'indexer', activity: 'reading' } },
          // Malformed: not shown at all rather than guessed at.
          { clientId: 33, agent: { name: 'odd', activity: 'deleting' } },
          { clientId: 34, agent: { activity: 'editing' } },
        ],
      }),
    )

    expect(view.result.current.peers).toEqual([
      { kind: 'person', clientId: 11, userId: 'u-jane', name: 'jane', ink: inkFor('u-jane') },
      { kind: 'agent', clientId: 31, name: 'Claude Code', ink: AI_INK, activity: 'editing' },
      { kind: 'agent', clientId: 32, name: 'indexer', ink: AI_INK, activity: 'reading' },
    ])
  })

  it('is synced only once the handshake is done with nothing left to send', async () => {
    const { view, provider } = await connected()
    expect(view.result.current.synced).toBe(false)

    provider.hasUnsyncedChanges = false
    act(() => provider.options.onSynced({ state: true }))
    expect(view.result.current.synced).toBe(true)

    provider.isSynced = true
    provider.hasUnsyncedChanges = true
    act(() => provider.options.onUnsyncedChanges({ number: 1 }))
    expect(view.result.current.synced).toBe(false)
  })

  it('a refused ticket is the revocation it is, and the editor stops being writable', async () => {
    // The share was pulled between page load and the websocket connect, so the
    // ticket endpoint 403s. Nothing else ever tells this hook it was kicked.
    ticket.mockRejectedValue(new ApiError(403, { error: 'share revoked' }))
    const view = mount()

    await waitFor(() => expect(view.result.current.status).toBe('revoked'))
    expect(view.result.current.writable).toBe(false)
    // No provider was ever built, so nothing is syncing what is typed next.
    expect(stub.providers).toHaveLength(0)
  })

  it('a ticket endpoint that is merely down is offline, not revoked — still unwritable', async () => {
    ticket.mockRejectedValue(new ApiError(500, { error: 'relay unavailable' }))
    const view = mount()

    await waitFor(() => expect(view.result.current.status).toBe('offline'))
    // The distinction is the point: a 500 is not a revocation and must not be
    // shown as one. Both, however, mean the keystrokes go nowhere.
    expect(view.result.current.status).not.toBe('revoked')
    expect(view.result.current.writable).toBe(false)
  })

  it('a refused reconnect ticket is a kick too, not a hopeful reconnect', async () => {
    const { view, provider } = await connected()
    act(() => provider.options.onStatus({ status: 'connected' }))
    // Spend the ticket the handshake already holds, so the next one is minted.
    await provider.options.token()
    ticket.mockRejectedValue(new ApiError(403, { error: 'share revoked' }))

    // The provider asks for a fresh ticket for the retry; the endpoint refuses.
    await expect(provider.options.token()).rejects.toBeInstanceOf(ApiError)

    await waitFor(() => expect(view.result.current.status).toBe('revoked'))
    expect(view.result.current.writable).toBe(false)
  })

  it('a kick empties the presence row', async () => {
    const { view, provider } = await connected()
    act(() =>
      provider.options.onAwarenessChange({
        states: [{ clientId: 11, user: { id: 'u-jane', name: 'jane' } }],
      }),
    )
    expect(view.result.current.peers).toHaveLength(1)

    act(() => provider.options.onAuthenticationFailed({ reason: 'permission-denied' }))

    // Avatars for a note the user no longer has any access to are a lie.
    expect(view.result.current.peers).toEqual([])
  })

  it('switching notes gives the new note its own document, never the old one', async () => {
    const view = renderHook(
      ({ path }: { path: string }) =>
        useCollabDoc({ vaultId: 'v-1', path, user: { id: 'u-taha', name: 'taha' }, enabled: true }),
      { initialProps: { path: 'a.md' } },
    )
    await waitFor(() => expect(stub.providers).toHaveLength(1))
    const first = stub.providers[0]!
    act(() => first.options.onStatus({ status: 'connected' }))
    act(() =>
      first.options.onAwarenessChange({
        states: [{ clientId: 11, user: { id: 'u-jane', name: 'jane' } }],
      }),
    )
    act(() => {
      view.result.current.ydoc.getText('body').insert(0, "note A's private body")
    })
    const docA = view.result.current.ydoc

    // The caller is not keyed on the note (task 7's NoteView split is unwritten).
    view.rerender({ path: 'b.md' })
    await waitFor(() => expect(stub.providers).toHaveLength(2))
    const second = stub.providers[1]!

    expect(second.options.name).toBe('v-1/b.md')
    // The whole finding: B's provider must not be handed A's CRDT, which would
    // upload A's body into B on the first sync step.
    expect(view.result.current.ydoc).not.toBe(docA)
    expect(second.options.document).toBe(view.result.current.ydoc)
    expect(view.result.current.ydoc.getText('body').toString()).toBe('')
    // A's text is still A's, and A's connection is gone.
    expect(docA.getText('body').toString()).toBe("note A's private body")
    expect(first.destroyed).toBe(true)
    // Nothing from A survives on screen either.
    expect(view.result.current.status).toBe('connecting')
    expect(view.result.current.peers).toEqual([])
  })

  it('never connects for a read-only viewer', async () => {
    const view = mount({ enabled: false })

    await waitFor(() => expect(view.result.current.status).toBe('connecting'))
    expect(ticket).not.toHaveBeenCalled()
    expect(stub.providers).toHaveLength(0)
  })

  it('tears down the provider and the document on unmount', async () => {
    const { view, provider } = await connected()

    view.unmount()

    expect(provider.destroyed).toBe(true)
    expect(view.result.current.ydoc.isDestroyed).toBe(true)
  })

  it('flushes pending updates and defers destroy until synced when unmounting with unsynced changes', async () => {
    const { view, provider } = await connected()
    provider.hasUnsyncedChanges = true

    view.unmount()

    expect(provider.flushedPendingUpdates).toBe(true)
    expect(provider.destroyed).toBe(false)

    act(() => {
      provider.emit('synced')
    })

    expect(provider.destroyed).toBe(true)
  })
  it('recovers from offline on its own — a blip must not lock the editor for the whole mount', async () => {
    // 'offline' used to be terminal: no provider was ever constructed, so
    // nothing retried and nothing could move the status again. One transient
    // 500 on first connect left a read-only editor until the page was
    // reloaded.
    vi.useFakeTimers()
    try {
      ticket.mockRejectedValueOnce(new ApiError(500, { error: 'relay restarting' }))
      ticket.mockResolvedValue(ticketNamed('retry-ticket'))
      const view = mount()

      await vi.waitFor(() => expect(view.result.current.status).toBe('offline'))
      expect(stub.providers).toHaveLength(0)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })

      // It asked again, got a ticket, and built the provider it never had.
      expect(stub.providers).toHaveLength(1)
      expect(view.result.current.status).not.toBe('offline')
      expect(view.result.current.writable).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a transient ticket failure mid-session stays reconnecting, not offline', async () => {
    // The provider is alive and retrying on its own here. Flipping to
    // 'offline' froze a live editor mid-sentence over one 500, while the
    // identical condition arriving as a dropped socket stayed writable.
    const { view, provider } = await connected()

    act(() => provider.options.onStatus({ status: 'connected' }))
    // Spend the handshake ticket so the next request mints a fresh one.
    await provider.options.token()
    // The socket drops: the provider is alive and retrying on its own.
    act(() => provider.options.onStatus({ status: 'disconnected' }))
    ticket.mockRejectedValueOnce(new ApiError(500, { error: 'blip' }))
    // Inside act(): without it the setStatus from the rejection has not
    // flushed when the assertion runs, so the test reads the status set
    // before it and passes no matter what the handler did.
    await act(async () => {
      await expect(provider.options.token()).rejects.toBeInstanceOf(ApiError)
    })

    expect(view.result.current.status).toBe('reconnecting')
    expect(view.result.current.writable).toBe(true)
  })

  it('resets the document when logging in after being disabled (logout then login)', async () => {
    const view = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCollabDoc({
          vaultId: 'v-1',
          path: 'journals/2026-08-25.md',
          user: { id: 'u-taha', name: 'taha' },
          enabled,
        }),
      { initialProps: { enabled: false } },
    )

    act(() => {
      view.result.current.ydoc.getText('body').insert(0, 'stale work before login')
    })
    const docBefore = view.result.current.ydoc

    view.rerender({ enabled: true })
    await waitFor(() => expect(stub.providers).toHaveLength(1))

    expect(view.result.current.ydoc).not.toBe(docBefore)
    expect(view.result.current.ydoc.getText('body').toString()).toBe('')
  })

  it('resets the document when user id changes', async () => {
    const view = renderHook(
      ({ user }: { user: { id: string; name: string } }) =>
        useCollabDoc({
          vaultId: 'v-1',
          path: 'journals/2026-08-25.md',
          user,
          enabled: true,
        }),
      { initialProps: { user: { id: 'u-alice', name: 'alice' } } },
    )
    await waitFor(() => expect(stub.providers).toHaveLength(1))

    act(() => {
      view.result.current.ydoc.getText('body').insert(0, "alice's edits")
    })
    const aliceDoc = view.result.current.ydoc

    view.rerender({ user: { id: 'u-bob', name: 'bob' } })
    await waitFor(() => expect(stub.providers).toHaveLength(2))

    expect(view.result.current.ydoc).not.toBe(aliceDoc)
    expect(view.result.current.ydoc.getText('body').toString()).toBe('')
  })

  it('preserves the document during socket reconnect while enabled remains true', async () => {
    const { view, provider } = await connected()
    const originalDoc = view.result.current.ydoc

    act(() => provider.options.onStatus({ status: 'connected' }))
    act(() => {
      originalDoc.getText('body').insert(0, 'preserved content')
    })

    // Simulate transient network disconnect / reconnect
    act(() => provider.options.onStatus({ status: 'disconnected' }))
    expect(view.result.current.status).toBe('reconnecting')
    expect(view.result.current.ydoc).toBe(originalDoc)
    expect(view.result.current.ydoc.getText('body').toString()).toBe('preserved content')

    act(() => provider.options.onStatus({ status: 'connected' }))
    expect(view.result.current.status).toBe('connected')
    expect(view.result.current.ydoc).toBe(originalDoc)
    expect(view.result.current.ydoc.getText('body').toString()).toBe('preserved content')
  })

  describe('offline (#720)', () => {
    it('a dropped socket is a drop at once, and the copy stops being synced', async () => {
      const { view, provider } = await connected()
      act(() => provider.options.onStatus({ status: 'connected' }))
      act(() => provider.options.onSynced({ state: true }))
      expect(view.result.current.synced).toBe(true)

      act(() => provider.options.onStatus({ status: 'disconnected' }))

      expect(view.result.current.status).toBe('reconnecting')
      // "Synced 10:04" over a dead socket is the lie the audit screenshot shows.
      expect(view.result.current.synced).toBe(false)
      expect(view.result.current.writable).toBe(true)
    })

    it('the browser going offline is a drop even while the socket still looks open', async () => {
      const { view, provider } = await connected()
      act(() => provider.options.onStatus({ status: 'connected' }))
      act(() => provider.options.onSynced({ state: true }))

      // Dead Wi-Fi or Chromium's offline emulation: no close frame, so the
      // provider keeps reporting Connected until its 30 s message timeout.
      act(() => {
        window.dispatchEvent(new Event('offline'))
      })
      expect(view.result.current.status).toBe('reconnecting')
      expect(view.result.current.synced).toBe(false)

      act(() => {
        window.dispatchEvent(new Event('online'))
      })
      expect(view.result.current.status).toBe('connected')
      expect(view.result.current.synced).toBe(true)
    })

    it('asks before unload only while something typed is unacknowledged', async () => {
      const add = vi.spyOn(window, 'addEventListener')
      const remove = vi.spyOn(window, 'removeEventListener')
      const beforeUnload = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === 'beforeunload')
      try {
        const { view, provider } = await connected()
        act(() => provider.options.onStatus({ status: 'connected' }))
        act(() => provider.options.onSynced({ state: true }))
        // An idle note never nags.
        expect(beforeUnload(add)).toHaveLength(0)
        expect(view.result.current.unsynced).toBe(false)

        act(() => provider.options.onStatus({ status: 'disconnected' }))
        act(() => {
          view.result.current.ydoc.getText('body').insert(0, 'typed with the socket down')
        })
        expect(view.result.current.unsynced).toBe(true)
        expect(beforeUnload(add)).toHaveLength(1)
        const warn = beforeUnload(add)[0]![1] as (event: Event) => void
        const event = new Event('beforeunload', { cancelable: true })
        warn(event)
        expect(event.defaultPrevented).toBe(true)

        // Back, and the relay acknowledged everything: nothing left to lose.
        provider.hasUnsyncedChanges = false
        act(() => provider.options.onStatus({ status: 'connected' }))
        act(() => provider.options.onSynced({ state: true }))
        expect(view.result.current.unsynced).toBe(false)
        expect(beforeUnload(remove).map(([, fn]) => fn)).toContain(warn)
      } finally {
        add.mockRestore()
        remove.mockRestore()
      }
    })

    it('never claims acknowledged while the provider still has unsent changes', async () => {
      const { view, provider } = await connected()
      act(() => provider.options.onStatus({ status: 'connected' }))
      act(() => provider.options.onSynced({ state: true }))
      act(() => {
        view.result.current.ydoc.getText('body').insert(0, 'in flight')
      })
      provider.hasUnsyncedChanges = true
      act(() => provider.options.onUnsyncedChanges({ number: 1 }))

      expect(view.result.current.unsynced).toBe(true)
      expect(view.result.current.synced).toBe(false)
    })
  })
})

