import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import { collabDocName, collabSocketUrl, getCollabTicket } from '../api/collab.js'
import type { CollabTicket } from '../api/collab.js'
import { ApiError } from '../lib/api.js'
import {
  closeCollabStash,
  collabStashName,
  hasCollabStash,
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
  /** The socket dropped mid-session (or the browser says it is offline): the
   *  provider is retrying, edits keep merging locally and are kept in this
   *  browser until the relay acknowledges them. */
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

  // The copy that could not be merged, open until the person discards it or
  // leaves. While it sits in the store the live document keeps no copy there:
  // the two do not share history, and one store must never hold both.
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

    const stashName = userRef.current.id ? collabStashName(userRef.current.id, docName) : null
    // This browser's copy of the live document, kept while something is unsent.
    let local: CollabStash | null = null
    // A copy left by an earlier session, shown until the relay's state arrives.
    let restore: { doc: Y.Doc; stash: CollabStash } | null = null
    // Until the store has been checked for such a copy, opening it for the live
    // document would load the copy into it unchecked (see `merge`).
    let restoring = stashName !== null
    let release: number | undefined

    const holdRelease = () => {
      clearTimeout(release)
      release = undefined
    }

    const keep = () => {
      holdRelease()
      if (local || !stashName || restoring || restore || unmergedRef.current) return
      local = openCollabStash(stashName, ydoc)
    }

    const acked = () => handshake && !browserOffline && !provider?.hasUnsyncedChanges

    /**
     * The copy from an earlier session meets the relay's document. Same
     * history (any Yjs client in common): Yjs merges by item id, so whatever
     * the relay already has is not applied twice and only the rest is sent.
     * No history in common means the relay's document was rebuilt from the
     * note's text (purged and re-created, or its CRDT state lost); merging then
     * appends a second copy of the note, so the text goes to the person instead.
     */
    const merge = () => {
      if (!restore) return
      const { doc: copy, stash } = restore
      restore = null
      setRestoredDoc(null)
      const relay = Y.decodeStateVector(Y.encodeStateVector(ydoc))
      const shared = [...Y.decodeStateVector(Y.encodeStateVector(copy)).keys()].some((client) => relay.has(client))
      if (!shared) {
        unmergedRef.current = {
          stash,
          doc: copy,
          afterDiscard: () => {
            if (!cancelled && dirty) keep()
          },
        }
        setUnmerged(copy.getText('body').toString())
        return
      }
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(copy, Y.encodeStateVector(ydoc)), RESTORE_ORIGIN)
      dirty = true
      setUnsynced(true)
      // The live document's own copy now holds everything; the old one is
      // emptied with it once the relay has acknowledged the merge. The copy
      // doc itself is left to the GC: the editor is still bound to it until
      // the next render swaps in the live document.
      keep()
      void closeCollabStash(stash)
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
          if (!local || !acked()) return
          const copy = local
          local = null
          void releaseCollabStash(copy)
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
      if (!revoked && everConnected) setStatus('reconnecting')
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
          if (!cancelled && restore) settle()
          else if (!cancelled && dirty) keep()
          else if (cancelled && dirty && !restore) {
            // Typed while the store was being checked, and unmounted before
            // it was: write it down once anyway, it is still unsent.
            const last = openCollabStash(stashName, ydoc)
            if (last) void closeCollabStash(last)
          }
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
            setStatus(browserOffline ? 'reconnecting' : 'connected')
          } else {
            socketOpen = false
            handshake = false
            setStatus(everConnected ? 'reconnecting' : 'connecting')
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
      if (local) void (dirty ? closeCollabStash(local) : releaseCollabStash(local))
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
    void releaseCollabStash(pending.stash).then(pending.afterDiscard)
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
