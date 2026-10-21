import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import { collabDocName, collabSocketUrl, getCollabTicket, legacyCollabDocName } from '../api/collab.js'
import type { CollabTicket } from '../api/collab.js'
import { ApiError } from '../lib/api.js'
import { claimLeftoverCopies, keepCollabCopy } from '../lib/collabStash.js'
import type { CollabCopy } from '../lib/collabStash.js'
import { collabStashName, hasCollabStash } from '../lib/collabStashNames.js'
import { AI_INK, inkFor } from '../lib/ink.js'
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
  /** The session ended (#498): logout here or in another tab, a password
   *  change or reset elsewhere, deactivation, expiry. The relay closed the
   *  socket and takes nothing more from that session; what was typed stays on
   *  screen and, until a logout here clears it, in this user's browser copy. */
  | 'signed-out'
  /** We never got a ticket and it was not a refusal — the API or the relay is
   *  down. Not a revocation, but nothing typed here is going anywhere either. */
  | 'offline'
  /** The relay refused a change because it would make the note larger than
   *  the server's size cap (#491). Nothing typed since is on the server; it is
   *  kept in this browser, the editor stays writable so the person can cut,
   *  and the hook reconnects by itself once the note fits again (on a new
   *  document, without the undo history, when the deleted text that history
   *  keeps would not fit through the relay's frame limit). */
  | 'too-large'
  /** The relay refused the note because the server's store migration has not
   *  processed it yet (ADR-003, close reason `note-not-migrated`): nothing can
   *  be stored until an administrator fixes the cause and restarts the server,
   *  so the editor is closed rather than letting typing go nowhere. */
  | 'not-migrated'
  /** The relay refused this tab's document name (ADR-003 §5.4, close reason
   *  `reload-required`): the server names documents differently from the
   *  bundle this tab runs. Nothing typed here reaches it; what was typed is
   *  kept in this browser and comes back after a reload. */
  | 'reload-required'
  /** The note was deleted (moved to the trash) or purged while open (ADR-003
   *  §5.5, close reason `note-deleted`): the relay closed the document and
   *  takes nothing more for it. What was typed stays on screen and in this
   *  browser; after a restore from the trash a reload brings it back. */
  | 'deleted'

/** A person editing this note, or an agent (an MCP connection) that read or wrote it. */
export type CollabPeer =
  | {
      kind: 'person'
      /** Yjs awareness client id — unique per tab, not per user. */
      clientId: number
      userId: string
      /** Label under the pen nib. */
      name: string
      ink: Ink
    }
  | {
      kind: 'agent'
      /** Awareness client id the relay gave this agent on this note. */
      clientId: number
      /** The MCP connection's label. */
      name: string
      /** Always {@link AI_INK}: teal means an AI is at work. */
      ink: Ink
      /** Editing until the relay's idle timeout (60 s) after its last write; reading otherwise. */
      activity: 'editing' | 'reading'
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
  /** Set while `status` is `too-large`: the server's cap and the note's size
   *  here, both in UTF-8 bytes as the server measures them. */
  tooLarge: { limitBytes: number; bodyBytes: number } | null
}

export interface UseCollabDocOptions {
  vaultId: string
  /** The note's id: it names the collab document (`collabDocName`). */
  noteId: string
  /** The note's current path: copies this browser kept under the path-keyed
   *  name of bundles before ADR-003 S2b are looked for there too. */
  path: string
  /** Local identity, broadcast in awareness so other editors can see who is here. */
  user: { id: string; name: string }
  /** False for read-only viewers: the relay refuses them by design and they use
   *  {@link import('./useLiveNote.js').useLiveNote} instead. */
  enabled: boolean
}

/** Dead ends: the states where a keystroke reaches no one. */
const DEAD: readonly CollabStatus[] = ['revoked', 'signed-out', 'offline', 'not-migrated', 'reload-required', 'deleted']

/**
 * Awareness is whatever a peer chose to broadcast: every field of a person's
 * state is that peer's own claim about itself, including `user.id`, so
 * nothing here may assert authorship from it.
 *
 * An agent's state is the exception, because only the relay writes it (#481,
 * server/src/sync/agent-presence.ts): when an MCP connection reads or writes
 * a note that is open, the relay adds `{ agent: { name, activity } }` under a
 * client id of its own, and it strips `agent` from every state a browser
 * sends. So `agent` is the one field that can earn teal; a `user` claiming to
 * be the MCP is a person like any other. Agents have no `user` and no cursor,
 * so the editor draws no caret for them.
 */
function toPeer(state: { clientId: number; [key: string]: unknown }): CollabPeer | null {
  const agent = state.agent as { name?: unknown; activity?: unknown } | undefined
  if (typeof agent?.name === 'string' && (agent.activity === 'editing' || agent.activity === 'reading')) {
    return { kind: 'agent', clientId: state.clientId, name: agent.name, ink: AI_INK, activity: agent.activity }
  }
  const user = state.user as { id?: unknown; name?: unknown } | undefined
  if (typeof user?.id !== 'string' || typeof user.name !== 'string') return null
  return {
    kind: 'person',
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

/**
 * Room for a sync message's envelope (document name, message types, lengths)
 * around the update it carries, against the relay's frame limit.
 */
const FRAME_ENVELOPE_BYTES = 1024

/** Transaction origin of a restored copy merged into the live document. */
const RESTORE_ORIGIN = Symbol('collab-restore')

/**
 * True if the two documents share any Yjs client, i.e. one history. Two
 * unrelated documents with the same text merge into the text twice.
 *
 * Any common client is enough because a stored copy is one document's own
 * history, never a mixture (see collabStash.ts): it has a client in common
 * with the relay's document only if it was synced with that document at some
 * point, and then every item in it is either on the relay already (Yjs skips
 * it by id) or typed on top of it. Requiring the relay to contain the copy's
 * state vector instead would refuse exactly the copies worth restoring: the
 * ones holding typing the relay never got.
 */
function sharesHistory(a: Y.Doc, b: Y.Doc): boolean {
  for (const client of a.store.clients.keys()) if (b.store.clients.has(client)) return true
  return false
}

/**
 * UTF-8 bytes of `text`, which is how the relay measures a note body against
 * its cap (server/src/notes/size-cap.ts), counted without encoding a copy.
 */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // A surrogate pair: one 4-byte character.
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/**
 * Joins the note's Yjs document on the Hocuspocus relay
 * (`server/src/sync/collab-server.ts`). Editors only.
 *
 * Being kicked is a normal outcome, not an error: the relay closes the socket
 * the instant a share is revoked, or the session ends (#498). When that happens
 * this hook stops reconnecting and reports `revoked` or `signed-out` — but it
 * never touches `ydoc`, so whatever the user had
 * typed is still on screen for them to copy out. Destroying the document on a
 * kick would delete their unsaved work, which is the one thing this must not do.
 */
export function useCollabDoc({ vaultId, noteId, path, user, enabled }: UseCollabDocOptions): CollabSession {
  const docName = collabDocName(vaultId, noteId)
  // Read at mount through a ref: a rename changes the path, never the document.
  const legacyNameRef = useRef(legacyCollabDocName(vaultId, path))
  useEffect(() => {
    legacyNameRef.current = legacyCollabDocName(vaultId, path)
  })

  const [awareness, setAwareness] = useState<HocuspocusProvider['awareness']>(null)
  const [status, setStatus] = useState<CollabStatus>('connecting')
  const [synced, setSynced] = useState(false)
  const [unsynced, setUnsynced] = useState(false)
  const [restoredDoc, setRestoredDoc] = useState<Y.Doc | null>(null)
  const [unmerged, setUnmerged] = useState<string | null>(null)
  const [peers, setPeers] = useState<CollabPeer[]>([])
  const [tooLarge, setTooLarge] = useState<CollabSession['tooLarge']>(null)
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
    setTooLarge(null)
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

  // Copies that could not be merged, kept until the person discards them or
  // leaves. They stay this tab's (no other tab offers them meanwhile).
  const unmergedRef = useRef<CollabCopy[] | null>(null)
  // A document rebuilt after a refusal (see `rebuild` below) and this
  // browser's copy of it, for the connect effect it re-runs to adopt.
  const handoffRef = useRef<{ ydoc: Y.Doc; copy: CollabCopy | null } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let provider: HocuspocusProvider | undefined
    let cancelled = false
    let everConnected = false
    // Revoked or signed out: the relay will not take this tab back.
    let stopped = false
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
    // The relay refused a change as too large; no reconnect until the body fits.
    let refused = false
    // The relay's body size cap and frame limit, from the latest ticket (the
    // provider only exists once the first ticket is in).
    let maxNoteBytes = 0
    let maxFrameBytes = 0
    // This effect's document is being replaced by a rebuilt one (`rebuild`).
    let handingOff = false

    const stashName = userRef.current.id ? collabStashName(userRef.current.id, docName) : null
    // Copies kept under the note's path-keyed name by a bundle before ADR-003
    // S2b are looked for too (§5.4), until none is left in this browser; they
    // meet the relay's document like any other copy (merged once if they
    // share its history, else offered as text). New copies use the id name.
    const legacyStashName = userRef.current.id ? collabStashName(userRef.current.id, legacyNameRef.current) : null
    // This browser's copy of the live document, kept while something is unsent.
    let live: CollabCopy | null = null
    // Copies left by earlier sessions, the first one shown, until the relay's
    // state arrives and each one is merged or offered.
    let restore: CollabCopy[] | null = null
    let release: number | undefined

    // A document rebuilt after a refusal: everything in it is unsent, and it
    // already has its copy in this browser.
    const handed = handoffRef.current
    if (handed?.ydoc === ydoc) {
      handoffRef.current = null
      live = handed.copy
      dirty = true
      everConnected = true
    }

    const holdRelease = () => {
      clearTimeout(release)
      release = undefined
    }

    const keep = () => {
      holdRelease()
      if (live || !stashName) return
      live = keepCollabCopy(stashName, ydoc)
    }

    /** Stops keeping the live document: keeps its copy if something is unsent, deletes it otherwise. */
    const drop = (unsent: boolean) => {
      if (!live) return
      const copy = live
      live = null
      void (unsent ? copy.close() : copy.release())
    }

    const acked = () => handshake && !browserOffline && !provider?.hasUnsyncedChanges

    // Not live and known to be out of reach: the socket dropped, or a copy
    // restored from this browser is waiting while connecting fails.
    const away = () => everConnected || (restore !== null && (attemptFailed || browserOffline))

    /**
     * The copies from earlier sessions meet the relay's document. Same
     * history: Yjs merges by item id, so whatever the relay already has is not
     * applied twice and only the rest (the unsent typing) is merged and sent;
     * the copy is deleted once the live document's own copy holds it. No
     * history in common means the relay's document was rebuilt from the
     * note's text (purged and re-created, or its CRDT state lost); merging
     * then appends a second copy of the note, so the text goes to the person
     * instead.
     */
    const merge = () => {
      if (!restore) return
      const copies = restore
      restore = null
      setRestoredDoc(null)
      const offered: CollabCopy[] = []
      for (const copy of copies) {
        if (!sharesHistory(copy.doc, ydoc)) {
          offered.push(copy)
          continue
        }
        // Unsent until the relay acknowledges the merge.
        dirty = true
        setUnsynced(true)
        keep()
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(copy.doc, Y.encodeStateVector(ydoc)), RESTORE_ORIGIN)
        // The editor stays bound to the shown copy until the next render: a
        // keystroke landing there in between belongs in the live document.
        copy.doc.on('update', (update: Uint8Array) => Y.applyUpdate(ydoc, update, RESTORE_ORIGIN))
        // Deleted only once the live copy holds it: a failed write (storage
        // full) keeps it, to be offered again on the next visit.
        const stored = live ? live.flushed() : Promise.resolve(false)
        void stored.then((ok) => (ok ? copy.release() : copy.close()))
      }
      if (offered.length === 0) return
      // Appended: a copy claimed later (#766) joins the ones already offered.
      const pending = [...(unmergedRef.current ?? []), ...offered]
      unmergedRef.current = pending
      setUnmerged(pending.map((copy) => copy.doc.getText('body').toString()).join('\n\n'))
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
      if (live && !release) {
        release = window.setTimeout(() => {
          release = undefined
          if (acked()) drop(false)
        }, RELEASE_MS)
      }
    }

    /** Shows the note's size against the cap; true when it fits again. */
    const measureTooLarge = () => {
      const bodyBytes = utf8Length(ydoc.getText('body').toString())
      setTooLarge({ limitBytes: maxNoteBytes, bodyBytes })
      return bodyBytes <= maxNoteBytes
    }

    /**
     * Sends the document again on a new provider. Reconnecting the old one
     * would first replay, one by one, the updates it queued since the
     * refusal; the relay judges each alone, and on a note already over the
     * cap a keystroke that adds text is refused even when later cuts make up
     * for it. A new provider's sync carries all of it in one update.
     */
    const restart = () => {
      const stale = provider
      provider = undefined
      setAwareness(null)
      stale?.destroy()
      void connect()
    }

    /**
     * Replaces the document with a copy holding only what is in it now. The
     * editor's undo history keeps deleted text in the document, so after a
     * paste the relay refused for its frame size, cutting or undoing the
     * paste still leaves it in what a reconnect sends, and the relay closes
     * the socket again. A new document built from this one's state has the
     * same history, so it still merges with the relay's, but deleted text is
     * dropped from it (Yjs garbage-collects deleted content on load), and so
     * is the undo history. This browser's copy moves to the new document
     * before the old one's is deleted.
     */
    const rebuild = () => {
      const rebuilt = new Y.Doc()
      Y.applyUpdate(rebuilt, Y.encodeStateAsUpdate(ydoc))
      const copy = stashName ? keepCollabCopy(stashName, rebuilt) : null
      const old = live
      live = null
      if (old) {
        void (copy ? copy.flushed().then((ok) => (ok ? old.release() : old.close())) : old.close())
      }
      handingOff = true
      handoffRef.current = { ydoc: rebuilt, copy }
      setDoc((current) => (current.ydoc === ydoc ? { ...current, ydoc: rebuilt } : current))
    }

    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      // The relay's updates carry the provider as origin; anything else was done here.
      if (provider !== undefined && origin === provider) return
      dirty = true
      setUnsynced(true)
      keep()
      // Cut down to size: send it again. The relay checks it the same way.
      if (!refused || handingOff || !measureTooLarge()) return
      setTooLarge(null)
      setStatus('reconnecting')
      // The whole state bounds what the sync sends.
      if (Y.encodeStateAsUpdate(ydoc).length + FRAME_ENVELOPE_BYTES > maxFrameBytes) {
        // `refused` stays set: this effect's provider is done.
        rebuild()
        return
      }
      refused = false
      restart()
    }
    ydoc.on('update', onUpdate)

    const wentOffline = () => {
      browserOffline = true
      if (!stopped && !refused && provider && away()) setStatus('reconnecting')
      settle()
    }
    const cameOnline = () => {
      browserOffline = false
      if (!stopped && !refused && socketOpen) setStatus('connected')
      settle()
    }
    window.addEventListener('offline', wentOffline)
    window.addEventListener('online', cameOnline)

    // Copies another tab held when this one looked: claimed as soon as that
    // tab goes away with something unsent (#766), and met with the relay's
    // document like the ones found at mount. Not shown in the editor.
    const watching = new AbortController()
    const found = (copy: CollabCopy) => {
      if (cancelled) {
        void copy.close().then(() => copy.doc.destroy())
        return
      }
      restore = [...(restore ?? []), copy]
      dirty = true
      setUnsynced(true)
      settle()
    }

    if (stashName) {
      void (async () => {
        let copies: CollabCopy[] = []
        for (const name of [stashName, legacyStashName]) {
          if (!name) continue
          try {
            if (await hasCollabStash(name)) {
              copies = [...copies, ...(await claimLeftoverCopies(name, { signal: watching.signal, found }))]
            }
          } catch {
            // IndexedDB refused (private mode, quota): no copy to restore.
          }
        }
        const shown = copies[0]
        if (cancelled || !shown) {
          for (const copy of copies) void copy.close().then(() => copy.doc.destroy())
          return
        }
        restore = [...copies, ...(restore ?? [])]
        dirty = true
        setUnsynced(true)
        setRestoredDoc(shown.doc)
        if (!stopped && provider && !socketOpen && away()) setStatus('reconnecting')
        settle()
      })()
    }

    /**
     * The relay will not take this tab back: stop and say why. The first
     * reason stands: a signed-out tab's reconnect is refused as well, and
     * that refusal must not turn it into a revocation.
     */
    const stop = (why: 'revoked' | 'signed-out' | 'not-migrated' | 'reload-required' | 'deleted') => {
      if (stopped) return
      stopped = true
      setStatus(why)
      // Nobody is "in the note with you" once you are out of it.
      setPeers([])
      provider?.disconnect()
    }

    // The relay refused us: the share was revoked, or it was never ours.
    // Retrying would only fail again.
    const kicked = () => stop('revoked')

    /**
     * The relay refused a change as too large (#491). Reconnecting would only
     * send the same change again, so stop until the person has cut the note
     * down; the document (and this browser's copy of it) keeps every keystroke.
     */
    const refuse = () => {
      if (refused || stopped) return
      refused = true
      handshake = false
      socketOpen = false
      setStatus('too-large')
      setPeers([])
      measureTooLarge()
      provider?.disconnect()
      settle()
    }

    /**
     * A 403 from the ticket endpoint is what a revoked share looks like from
     * here, and retrying it would only fail again — that is terminal. A 401
     * is a session that ended (#498), terminal too: a retry that succeeded
     * later would be under whatever session this browser holds by then,
     * possibly someone else's.
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
      if (error instanceof ApiError && error.status === 401) {
        stop('signed-out')
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

    /**
     * The relay could not load the note because its store is busy
     * (`store-busy`: a lock timeout, maintenance, Postgres away; S3 also
     * closes the socket when it cannot log a change). Not a revocation: keep
     * the text and its unsent changes, and connect again on a new provider
     * after a pause, which resends them.
     */
    const storeBusy = () => {
      if (stopped || refused || cancelled) return
      setStatus('reconnecting')
      const busy = provider
      provider = undefined
      busy?.destroy()
      clearTimeout(retry)
      retry = setTimeout(() => {
        if (!cancelled && !stopped) void connect()
      }, RETRY_MS)
    }

    const connect = async () => {
      // The ticket carries both the credential and the relay's URL; the relay
      // listens on its own port and nothing else tells the client where.
      let first: CollabTicket
      try {
        first = await getCollabTicket()
        maxNoteBytes = first.maxNoteBytes
        maxFrameBytes = first.maxFrameBytes
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
            const ticket = await getCollabTicket()
            maxNoteBytes = ticket.maxNoteBytes
            maxFrameBytes = ticket.maxFrameBytes
            return ticket.token
          } catch (error) {
            // A reconnect ticket that 403s is the same revocation the relay
            // would have reported; swallowed here it reads as "reconnecting".
            ticketFailed(error)
            throw error
          }
        },
        onStatus: ({ status: socketStatus }) => {
          if (stopped || refused) return
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
        // `note-not-migrated`: the server's store migration has not processed this note; `reload-required`: the
        // server names documents differently from this bundle (ADR-003 §5.4); `note-deleted`: the note is in the
        // trash or purged; `store-busy`: the relay could not load the note from its store just now (retried);
        // anything else is a revocation.
        onAuthenticationFailed: ({ reason }) =>
          reason === 'note-not-migrated'
            ? stop('not-migrated')
            : reason === 'reload-required'
              ? stop('reload-required')
              : reason === 'note-deleted'
                ? stop('deleted')
                : reason === 'store-busy'
                  ? storeBusy()
                  : kicked(),
        // The relay closes the document with reason `note-too-large` for a
        // change over the cap (server/src/sync/collab-server.ts), ws closes
        // the socket with 1009 for a frame over its transport limit, the
        // relay closes with `signed-out` when the session ended (#498), and
        // with `note-deleted` when the note is deleted or purged.
        onClose: ({ event }) => {
          if (event.reason === 'signed-out') stop('signed-out')
          else if (event.reason === 'note-deleted') stop('deleted')
          else if (event.reason === 'note-too-large' || event.code === 1009) refuse()
        },
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
      watching.abort()
      clearTimeout(retry)
      holdRelease()
      ydoc.off('update', onUpdate)
      window.removeEventListener('offline', wentOffline)
      window.removeEventListener('online', cameOnline)
      // Unsent: keep the copy for the next visit. Otherwise it can go.
      drop(dirty)
      // Copies from earlier sessions not merged or discarded yet: kept for
      // the next visit. A rebuilt document keeps showing the unmerged ones.
      const leftover = handingOff ? (restore ?? []) : [...(restore ?? []), ...(unmergedRef.current ?? [])]
      for (const copy of leftover) void copy.close().then(() => copy.doc.destroy())
      restore = null
      if (!handingOff) unmergedRef.current = null
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
    for (const copy of pending) void copy.release().then(() => copy.doc.destroy())
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
    tooLarge,
  }
}
