import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import { collabDocName, getCollabTicket } from '../api/collab.js'
import type { CollabTicket } from '../api/collab.js'
import { ApiError } from '../lib/api.js'
import { inkFor } from '../lib/ink.js'
import type { Ink } from '../lib/ink.js'

export type CollabStatus =
  /** First handshake in flight. */
  | 'connecting'
  /** Live. Edits merge as they are typed. */
  | 'connected'
  /** Dropped mid-session; the provider is retrying and edits keep merging locally. */
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
  const [peers, setPeers] = useState<CollabPeer[]>([])
  // The document is keyed on the note, not on the mount: the connect effect
  // re-runs on a docName change, and reconnecting the OLD doc under the NEW
  // name uploads note A's body into note B. React's adjust-state-during-render
  // pattern — an effect would leave one render holding the mismatched pair.
  const [doc, setDoc] = useState(() => ({ name: docName, ydoc: new Y.Doc() }))
  if (doc.name !== docName) {
    setDoc({ name: docName, ydoc: new Y.Doc() })
    setStatus('connecting')
    setSynced(false)
    setPeers([])
  }
  const ydoc = doc.ydoc

  // Identity can change (a rename) without justifying a reconnect, so the mount
  // effect reads it through a ref — same pattern as useCodeMirrorEditor.
  const userRef = useRef(user)
  useEffect(() => {
    userRef.current = user
  })

  useEffect(() => {
    if (!enabled) return
    let provider: HocuspocusProvider | undefined
    let cancelled = false
    let everConnected = false
    let revoked = false
    let retry: ReturnType<typeof setTimeout> | undefined

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
        url: first.url,
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
            setStatus('connected')
          } else {
            setStatus(everConnected ? 'reconnecting' : 'connecting')
          }
        },
        onAuthenticationFailed: kicked,
        onSynced: () => setSynced(!provider?.hasUnsyncedChanges),
        onUnsyncedChanges: () => setSynced(Boolean(provider?.isSynced) && !provider?.hasUnsyncedChanges),
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
      provider?.destroy()
      setAwareness(null)
    }
    // `user` is deliberately absent: see userRef above.
  }, [ydoc, docName, enabled])

  // Destroying the doc is separate from tearing down the connection: a
  // reconnect must reuse the same document, and a kick must not empty it. A
  // note switch does replace it, and this cleanup is what retires the old one.
  useEffect(() => () => ydoc.destroy(), [ydoc])

  return { ydoc, awareness, status, synced, peers, writable: !DEAD.includes(status) }
}
