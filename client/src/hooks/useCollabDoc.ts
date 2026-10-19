import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import { collabDocName, collabSocketUrl, getCollabTicket } from '../api/collab.js'
import type { CollabTicket } from '../api/collab.js'
import { ApiError } from '../lib/api.js'
import {
  closeCollabStash,
  collabStashName,
  discardCollabStash,
  hasCollabStash,
  holdCollabStash,
  openCollabStash,
  releaseCollabStash,
} from '../lib/collabStash.js'
import type { CollabStash } from '../lib/collabStash.js'
import { inkFor } from '../lib/ink.js'
import type { Ink } from '../lib/ink.js'

export type CollabStatus =
  /** First handshake in flight. */
  | 'connecting'
  /** Live. Edits merge as they are typed. */
  | 'connected'
  /** The socket dropped mid-session (or the browser says it is offline, or a
   *  copy restored from this browser cannot reach the relay): the provider is
   *  retrying, edits keep merging locally and are kept in this browser until
   *  the relay acknowledges them. */
  | 'reconnecting'
  /** Access was pulled. The relay kicked us and will not take us back. */
  | 'revoked'
  /** We never got a ticket and it was not a refusal — the API or the relay is
   *  down. Not a revocation, but nothing typed here is going anywhere either. */
  | 'offline'

export interface CollabPeer {
  /** Yjs awareness client id — unique per tab, not per user. */
  clientId: number
  userId: string
  /** Label under the pen nib. */
  name: string
  ink: Ink
  /** True for the AI/MCP participant, which wears teal and never an ink hue.
   *  Always false today: see {@link toPeer} — nothing the relay sends can tell
   *  a real MCP connection from a human client claiming to be one. */
}

export interface CollabSession {
  /** The shared document. `getText('body')` and `getMap('frontmatter')` are the
   *  two shapes the relay loads and stores — do not invent others. */
  ydoc: Y.Doc
  /** Awareness instance for `yCollab(ytext, awareness)`. Null until connected. */
  awareness: HocuspocusProvider['awareness']
  status: CollabStatus
  /** True when the handshake is done and nothing local is still unsent. This is
   *  as far as the client can honestly go: the relay's own write to disk is
   *  debounced and unacknowledged, so the copy is "synced", never "saved". */
  synced: boolean
  /** Everyone else in this document. Never includes the local user. */
  peers: CollabPeer[]
  /** False once edits have nowhere to go. Pass it straight to the editor's
   *  `readOnly`: a caller that enumerates statuses itself will miss one, and
   *  the failure mode is a person typing into a document nothing is syncing. */
  writable: boolean
  /** True while something typed here has not been acknowledged by the relay.
   *  Leaving the page then loses it unless this browser's copy survives, so
   *  the hook asks before unload for as long as this is true. */
  unsynced: boolean
  /** True while `ydoc` is a copy restored from this browser that is not merged
   *  with the relay's document yet: shown even when the relay is unreachable. */
  restored: boolean
  /** Text kept in this browser from an earlier session that was NOT merged,
   *  because the relay's document no longer shares any history with it (the
   *  note was re-created, or its CRDT state was lost). Merging two unrelated
   *  histories duplicates the whole note, so the person gets the text instead. */
  unmerged: string | null
  /** Deletes the copy behind `unmerged` from this browser. */
  discardUnmerged: () => void
}

export interface UseCollabDocOptions {
  vaultId: string
  path: string
  /** Local identity, broadcast in awareness so other editors can see who is here. */
  user: { id: string; name: string }
  /** False for read-only viewers: the relay refuses them by design and they use
   *  {@link import('./useLiveNote.js').useLiveNote} instead. */
  enabled: boolean
}

/** Dead ends: the two states where a keystroke reaches no one. */
const DEAD: readonly CollabStatus[] = ['revoked', 'offline']

/**
 * Awareness is whatever a peer chose to broadcast: every field here is that
 * peer's own claim about itself, including `user.id`, so nothing here may
 * assert authorship from it.
 *
 * There is also no AI peer to assert: MCP does not join this protocol at all.
 * `writeThroughCollab` (server/src/mcp/crdt-write.ts) edits via Hocuspocus's
 * `openDirectConnection`, a server-side handle onto the document that never
 * broadcasts awareness — so an MCP edit arrives as a change with no cursor and
 * no presence entry, and every peer in this list is a person.
 *
 * If MCP ever does join awareness, identity must come from the relay, which
 * already knows it — `onAuthenticate` returns `{ userId }` as the connection
 * context (server/src/sync/collab-server.ts). The server would have to reject
 * or overwrite an awareness `user` whose id is not that authenticated id.
 */
function toPeer(state: { clientId: number; [key: string]: unknown }): CollabPeer | null {
  const user = state.user as { id?: unknown; name?: unknown } | undefined
  if (typeof user?.id !== 'string' || typeof user.name !== 'string') return null
  return {
    clientId: state.clientId,
    userId: user.id,
    name: user.name,
    ink: inkFor(user.id),
  }
}

/**
 * How long to wait before asking for a ticket again after the endpoint failed
 * for a reason that is not a revocation. Fixed rather than backing off: the
 * failure this recovers from is a restart or a blip, and the person is sitting
 * in front of a read-only editor waiting for it.
 *
 * ponytail: fixed interval; exponential backoff if a real outage ever makes
 * this hammer a downed relay.
 */
const RETRY_MS = 5_000

/**
 * How long the relay must have acknowledged everything before this browser's
 * copy is emptied: a pause in the typing, not every keystroke.
 */
const RELEASE_MS = 1_000

/** Transaction origin of a restored copy merged into the live document. */
const RESTORE_ORIGIN = Symbol('collab-restore')

/**
 * True if the two documents share any Yjs client, i.e. one history. Two
 * unrelated documents with the same text merge into the text twice.
 */
function sharesHistory(a: Y.Doc, b: Y.Doc): boolean {
  for (const client of a.store.clients.keys()) if (b.store.clients.has(client)) return true
  return false
}

/**
 * Joins the note's Yjs document on the Hocuspocus relay
 * (`server/src/sync/collab-server.ts`). Editors only.
 *
 * Being kicked is a normal outcome, not an error: the relay closes the socket
 * the instant a share is revoked. When that happens this hook stops reconnecting
 * and reports `revoked` — but it never touches `ydoc`, so whatever the user had
 * typed is still on screen for them to copy out. Destroying the document on a
 * kick would delete their unsaved work, which is the one thing this must not do.
 */
export function useCollabDoc({ vaultId, path, user, enabled }: UseCollabDocOptions): CollabSession {
  const docName = collabDocName(vaultId, path)

  const [awareness, setAwareness] = useState<HocuspocusProvider['awareness']>(null)
  const [status, setStatus] = useState<CollabStatus>('connecting')
  const [synced, setSynced] = useState(false)
  const [unsynced, setUnsynced] = useState(false)
  const [restoredDoc, setRestoredDoc] = useState<Y.Doc | null>(null)
  const [unmerged, setUnmerged] = useState<string | null>(null)
  const [peers, setPeers] = useState<CollabPeer[]>([])
  // The document is keyed on the note, not on the mount: the connect effect
  // re-runs on a docName change, and reconnecting the OLD doc under the NEW
  // name uploads note A's body into note B. React's adjust-state-during-render
  // pattern — an effect would leave one render holding the mismatched pair.
  const [doc, setDoc] = useState(() => ({
    name: docName,
    userId: user.id,
    enabled,
    ydoc: new Y.Doc(),
  }))
  if (
    doc.name !== docName ||
    (user.id && doc.userId && doc.userId !== user.id) ||
    (!doc.enabled && enabled)
  ) {
    setDoc({ name: docName, userId: user.id, enabled, ydoc: new Y.Doc() })
    setStatus('connecting')
    setSynced(false)
    setUnsynced(false)
    setRestoredDoc(null)
    setUnmerged(null)
    setPeers([])
  } else if (doc.enabled !== enabled) {
    setDoc({ ...doc, enabled })
  }
  const ydoc = doc.ydoc

  // Identity can change (a rename) without justifying a reconnect, so the mount
  // effect reads it through a ref — same pattern as useCodeMirrorEditor.
  const userRef = useRef(user)
  useEffect(() => {
    userRef.current = user
  })

  // The copy that could not be merged, open until the person discards it (in
  // any tab) or leaves. While it sits in the store the live document keeps no
  // copy there: the two do not share history, and one store must never hold
  // both.
  const unmergedRef = useRef<{ stash: CollabStash; doc: Y.Doc; afterDiscard: () => void } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let provider: HocuspocusProvider | undefined
    let cancelled = false
    let everConnected = false
    let revoked = false
    let retry: ReturnType<typeof setTimeout> | undefined
    // The relay's state has arrived since the socket last opened.
    let handshake = false
    let socketOpen = false
    // A silent drop (dead Wi-Fi, Chromium's offline emulation) leaves the
    // socket looking open for up to the provider's 30 s message timeout; the
    // browser's `offline` event says it at once.
    let browserOffline = navigator.onLine === false
    // Something typed here that the relay has not acknowledged.
    let dirty = false
    // A connection attempt failed since the socket last opened.
    let attemptFailed = false

    const stashName = userRef.current.id ? collabStashName(userRef.current.id, docName) : null
    // This browser's copy of the live document, kept while something is unsent.
    // The store is open on `mirror`, never on the live document: y-indexeddb
    // loads whatever is stored into the doc it keeps, unchecked, and anything
    // loaded into the live document goes to the relay. The live document's
    // updates are copied into `mirror`; nothing flows back except through
    // `adopt`'s history check.
    let local: { stash: CollabStash; mirror: Y.Doc; stop: () => void } | null = null
    let opening = false
    // A copy left by an earlier session, shown until the relay's state arrives.
    let restore: { doc: Y.Doc; stash: CollabStash } | null = null
    // Until the store has been checked for such a copy, nothing else opens it.
    let restoring = stashName !== null
    let release: number | undefined

    const holdRelease = () => {
      clearTimeout(release)
      release = undefined
    }

    /** Stops keeping the live document: keeps the store if something is unsent, empties it otherwise. */
    const drop = (unsent: boolean) => {
      if (!local) return
      const { stash, mirror, stop } = local
      local = null
      stop()
      void (unsent ? closeCollabStash(stash) : releaseCollabStash(stash)).finally(() => mirror.destroy())
    }

    /**
     * The text could not be merged: the person gets it in a notice, and the
     * copy stays in the store, never written back by any tab, until they
     * discard it here or in another tab.
     */
    const offer = (stash: CollabStash, copy: Y.Doc) => {
      if (cancelled) {
        void closeCollabStash(stash)
        copy.destroy()
        return
      }
      const afterDiscard = () => {
        if (!cancelled && dirty) keep()
      }
      unmergedRef.current = { stash, doc: copy, afterDiscard }
      holdCollabStash(stash, () => {
        if (unmergedRef.current?.stash !== stash) return
        unmergedRef.current = null
        setUnmerged(null)
        copy.destroy()
        void closeCollabStash(stash).then(afterDiscard)
      })
      setUnmerged(copy.getText('body').toString())
    }

    /**
     * `copy` holds what the store holds; from here on it is the live
     * document's mirror in the store. Same history as the live document (any
     * Yjs client in common), or nothing stored: Yjs merges by item id, so
     * whatever the live document already has is not applied twice and only
     * the rest (an earlier session's unsent typing) is merged and sent. No
     * history in common means the relay's document was rebuilt from the
     * note's text (purged and re-created, or its CRDT state lost); merging
     * then appends a second copy of the note, so the text goes to the person
     * instead.
     */
    const adopt = (stash: CollabStash, copy: Y.Doc) => {
      if (copy.store.clients.size > 0 && !sharesHistory(copy, ydoc)) {
        offer(stash, copy)
        return
      }
      const forward = (update: Uint8Array) => Y.applyUpdate(copy, update)
      ydoc.on('update', forward)
      local = { stash, mirror: copy, stop: () => ydoc.off('update', forward) }
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc, Y.encodeStateVector(copy)))
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(copy, Y.encodeStateVector(ydoc)), RESTORE_ORIGIN)
      if (cancelled) drop(dirty)
    }

    const keep = () => {
      holdRelease()
      if (local || opening || !stashName || restoring || restore || unmergedRef.current) return
      const mirror = new Y.Doc()
      const stash = openCollabStash(stashName, mirror)
      if (!stash) {
        mirror.destroy()
        return
      }
      opening = true
      void stash.loaded.then(
        () => {
          opening = false
          adopt(stash, mirror)
          if (!cancelled) settle()
        },
        () => {
          // IndexedDB refused (private mode, quota): nothing kept here.
          opening = false
          void closeCollabStash(stash)
          mirror.destroy()
        },
      )
    }

    const acked = () => handshake && !browserOffline && !provider?.hasUnsyncedChanges

    // Not live and known to be out of reach: the socket dropped, or a copy
    // restored from this browser is waiting while connecting fails.
    const away = () => everConnected || (restore !== null && (attemptFailed || browserOffline))

    /**
     * The copy from an earlier session meets the relay's document, through
     * the same history check as any other stored copy (`adopt`).
     */
    const merge = () => {
      if (!restore) return
      const { doc: copy, stash } = restore
      restore = null
      setRestoredDoc(null)
      // Unsent until the relay acknowledges the merge. The editor is still
      // bound to the copy until the next render swaps in the live document.
      dirty = true
      setUnsynced(true)
      adopt(stash, copy)
    }

    /** Re-reads where the document stands after anything that can move it. */
    const settle = () => {
      if (handshake && restore) merge()
      const done = acked()
      setSynced(done)
      if (!done || restore) {
        holdRelease()
        return
      }
      dirty = false
      setUnsynced(false)
      if (local && !release) {
        release = window.setTimeout(() => {
          release = undefined
          if (acked()) drop(false)
        }, RELEASE_MS)
      }
    }

    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      // The relay's updates carry the provider as origin; anything else was done here.
      if (provider !== undefined && origin === provider) return
      dirty = true
      setUnsynced(true)
      keep()
    }
    ydoc.on('update', onUpdate)

    const wentOffline = () => {
      browserOffline = true
      if (!revoked && provider && away()) setStatus('reconnecting')
      settle()
    }
    const cameOnline = () => {
      browserOffline = false
      if (!revoked && socketOpen) setStatus('connected')
      settle()
    }
    window.addEventListener('offline', wentOffline)
    window.addEventListener('online', cameOnline)

    if (stashName) {
      void (async () => {
        let stash: CollabStash | null = null
        const copy = new Y.Doc()
        try {
          if (!(await hasCollabStash(stashName)) || cancelled) return
          stash = openCollabStash(stashName, copy)
          await stash?.loaded
          if (!stash || cancelled || copy.store.clients.size === 0) return
          restore = { doc: copy, stash }
          stash = null
          dirty = true
          setUnsynced(true)
          setRestoredDoc(copy)
        } catch {
          // IndexedDB refused (private mode, quota): no copy to restore.
        } finally {
          if (stash) void closeCollabStash(stash)
          if (restore?.doc !== copy) copy.destroy()
          restoring = false
          if (!cancelled && restore) {
            if (!revoked && provider && !socketOpen && away()) setStatus('reconnecting')
            settle()
          }
          // Typed while the store was being checked (even if unmounted since:
          // `adopt` writes it down once, it is still unsent).
          else if (dirty && !restore) keep()
        }
      })()
    }

    const kicked = () => {
      // The relay refused us: the share was revoked, or it was never ours.
      // Retrying would only fail again, so stop and say so.
      revoked = true
      setStatus('revoked')
      // Nobody is "in the note with you" once you are out of it.
      setPeers([])
      provider?.disconnect()
    }

    /**
     * A 403 from the ticket endpoint is what a revoked share looks like from
     * here, and retrying it would only fail again — that is terminal.
     *
     * Anything else is the service being down, which is NOT terminal and must
     * not be treated as one:
     * - Mid-session, the provider is alive and already retrying, so the honest
     *   status is whatever `onStatus` is reporting ('reconnecting'). Flipping
     *   to 'offline' there froze a live editor mid-sentence over one 500.
     * - On first connect there is no provider to do the retrying, so this
     *   schedules it. Without that, a single transient failure locked the
     *   editor read-only for the whole life of the mount.
     */
    const ticketFailed = (error: unknown) => {
      if (error instanceof ApiError && error.status === 403) {
        kicked()
        return
      }
      if (provider) return
      setStatus('offline')
      retry = setTimeout(() => {
        if (cancelled) return
        // Back to 'connecting' before the attempt, not after it succeeds:
        // leaving 'offline' on screen while a retry is in flight tells the
        // person nothing is happening at the moment something is.
        setStatus('connecting')
        void connect()
      }, RETRY_MS)
    }

    const connect = async () => {
      // The ticket carries both the credential and the relay's URL; the relay
      // listens on its own port and nothing else tells the client where.
      let first: CollabTicket
      try {
        first = await getCollabTicket()
      } catch (error) {
        // Without this catch the status whispers "connecting…" forever over a
        // writable editor — the one combination that loses a person's work.
        if (!cancelled) ticketFailed(error)
        return
      }
      if (cancelled) return
      let firstToken: string | null = first.token

      provider = new HocuspocusProvider({
        // Resolved against this page's origin — see collabSocketUrl.
        url: collabSocketUrl(first.url, window.location.href),
        name: docName,
        document: ydoc,
        // A ticket is single-use, so every reconnect needs a fresh one. The
        // first one is already in hand — spend it before asking for another.
        token: async () => {
          if (firstToken !== null) {
            const token = firstToken
            firstToken = null
            return token
          }
          try {
            return (await getCollabTicket()).token
          } catch (error) {
            // A reconnect ticket that 403s is the same revocation the relay
            // would have reported; swallowed here it reads as "reconnecting".
            ticketFailed(error)
            throw error
          }
        },
        onStatus: ({ status: socketStatus }) => {
          if (revoked) return
          if (socketStatus === WebSocketStatus.Connected) {
            everConnected = true
            socketOpen = true
            attemptFailed = false
            setStatus(browserOffline ? 'reconnecting' : 'connected')
          } else {
            if (socketStatus === WebSocketStatus.Disconnected) attemptFailed = true
            socketOpen = false
            handshake = false
            setStatus(away() ? 'reconnecting' : 'connecting')
            settle()
          }
        },
        onAuthenticationFailed: kicked,
        onSynced: () => {
          handshake = true
          settle()
        },
        onUnsyncedChanges: () => settle(),
        onAwarenessChange: ({ states }) => {
          const self = provider?.awareness?.clientID
          setPeers(states.filter((s) => s.clientId !== self).map(toPeer).filter((p) => p !== null))
        },
      })

      const ink = inkFor(userRef.current.id)
      provider.setAwarenessField('user', {
        id: userRef.current.id,
        name: userRef.current.name,
        // yCollab reads `color` and `colorLight` off this field verbatim.
        color: ink.color,
        colorLight: ink.colorLight,
      })
      setAwareness(provider.awareness)
    }

    void connect()

    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
      holdRelease()
      ydoc.off('update', onUpdate)
      window.removeEventListener('offline', wentOffline)
      window.removeEventListener('online', cameOnline)
      // Unsent: keep the copy for the next visit. Otherwise it can go.
      drop(dirty)
      if (restore) {
        void closeCollabStash(restore.stash)
        restore.doc.destroy()
      }
      if (unmergedRef.current) {
        void closeCollabStash(unmergedRef.current.stash)
        unmergedRef.current.doc.destroy()
        unmergedRef.current = null
      }
      setAwareness(null)
      if (provider) {
        const p = provider as unknown as {
          flushPendingUpdates?: () => void
          hasUnsyncedChanges?: boolean
          destroy: () => void
          on?: (event: string, cb: () => void) => void
        }
        p.flushPendingUpdates?.()
        if (p.hasUnsyncedChanges) {
          const active = p
          const timer = setTimeout(() => active.destroy(), 1500)
          if (typeof active.on === 'function') {
            active.on('synced', () => {
              clearTimeout(timer)
              active.destroy()
            })
          }
        } else {
          provider.destroy()
        }
      }
    }
    // `user` is deliberately absent: see userRef above.
  }, [ydoc, docName, enabled])

  // Destroying the doc is separate from tearing down the connection: a
  // reconnect must reuse the same document, and a kick must not empty it. A
  // note switch does replace it, and this cleanup is what retires the old one.
  useEffect(() => () => ydoc.destroy(), [ydoc])

  // Leaving the page with unacknowledged text: the browser asks first. Only
  // while there is something to lose, so an idle note never nags.
  useEffect(() => {
    if (!unsynced) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older Chromium and Safari only prompt when returnValue is set.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsynced])

  const discardUnmerged = useCallback(() => {
    const pending = unmergedRef.current
    if (!pending) return
    unmergedRef.current = null
    setUnmerged(null)
    pending.doc.destroy()
    void discardCollabStash(pending.stash).then(pending.afterDiscard)
  }, [])

  return {
    // A restored copy is what the person sees and types into until it is
    // merged; it has no presence of its own.
    ydoc: restoredDoc ?? ydoc,
    awareness: restoredDoc ? null : awareness,
    status,
    synced,
    peers,
    writable: !DEAD.includes(status),
    unsynced,
    restored: restoredDoc !== null,
    unmerged,
    discardUnmerged,
  }
}
